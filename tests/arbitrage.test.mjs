import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findOpportunities } from '../src/core/arbitrage.ts'
import { connectMarketStream } from '../src/core/binance.ts'
import { createPaperAccount, parsePaperAccount, recordPaperTrade } from '../src/core/paperTrading.ts'

const markets = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
  { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING', isSpotTradingAllowed: true },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
]
const quote = (symbol, bidPrice, askPrice, bidQty = '100', askQty = '100', receivedAt = 1000) =>
  [symbol, { symbol, bidPrice, askPrice, bidQty, askQty, receivedAt }]
const books = new Map([
  quote('BTCUSDT', '59990', '60000'),
  quote('ETHBTC', '.04999', '.05'),
  quote('ETHUSDT', '3060', '3061'),
])
const params = { startAsset: 'USDT', amount: 68, feeBps: 10, slippageBps: 5, minNetBps: 10, maxAgeMs: 2000 }

test('finds the three-leg route and applies costs on every leg', () => {
  const result = findOpportunities(markets, books, params, 1500)
  assert.equal(result[0].route.join('>'), 'USDT>BTC>ETH>USDT')
  const factor = (1 - 10 / 10000) * (1 - 5 / 10000)
  const expected = (68 / 60000) * factor / .05 * factor * 3060 * factor
  assert.ok(Math.abs(result[0].output - expected) < 1e-12)
})

test('rejects quotes that exceed the freshness window', () => {
  const stale = new Map([...books].map(([symbol, item]) => [symbol, { ...item, receivedAt: 0 }]))
  assert.deepEqual(findOpportunities(markets, stale, params, 2500), [])
})

test('rejects a route when the best ask cannot cover the virtual input', () => {
  const shallow = new Map(books)
  shallow.set('BTCUSDT', { ...shallow.get('BTCUSDT'), askQty: '.00001' })
  assert.deepEqual(findOpportunities(markets, shallow, { ...params, feeBps: 0, slippageBps: 0, minNetBps: 0 }, 1500), [])
})

test('does not emit a route when costs put it below the net threshold', () => {
  assert.deepEqual(findOpportunities(markets, books, { ...params, feeBps: 100, slippageBps: 50 }, 1500), [])
})

const paperOpportunity = {
  route: ['USDT', 'BTC', 'ETH', 'USDT'],
  symbols: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'],
  input: 10,
  output: 10.02,
  netBps: 20,
  oldestQuoteMs: 200,
}

test('paper trading credits only simulated net profit and persists its ledger', () => {
  const result = recordPaperTrade(createPaperAccount(100), paperOpportunity, 10_000)
  assert.equal(result.accepted, true)
  if (!result.accepted) return
  assert.equal(result.account.balance, 100.02)
  assert.equal(result.account.totalTrades, 1)
  assert.ok(Math.abs(result.trade.profit - 0.02) < 1e-12)
  const restored = parsePaperAccount(JSON.stringify(result.account))
  assert.equal(restored.balance, 100.02)
  assert.equal(restored.trades[0].symbols.join('>'), 'BTCUSDT>ETHBTC>ETHUSDT')
})

test('paper trading prevents repeated, stale, unprofitable and unaffordable routes', () => {
  const account = createPaperAccount(5)
  assert.equal(recordPaperTrade(account, paperOpportunity, 10_000).accepted, false)
  assert.equal(recordPaperTrade(createPaperAccount(100), { ...paperOpportunity, oldestQuoteMs: 2_001 }, 10_000).accepted, false)
  assert.equal(recordPaperTrade(createPaperAccount(100), { ...paperOpportunity, output: 9.99 }, 10_000).accepted, false)
  const first = recordPaperTrade(createPaperAccount(100), paperOpportunity, 10_000)
  assert.equal(first.accepted, true)
  if (first.accepted) assert.equal(recordPaperTrade(first.account, paperOpportunity, 10_001).accepted, false)
})

test('connects on TLS port 443 and subscribes in bounded batches', async () => {
  const previousWindow = globalThis.window
  const previousWebSocket = globalThis.WebSocket
  const sockets = []
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    send(payload) { this.sent.push(JSON.parse(payload)) }
    open() { this.readyState = 1; this.onopen?.() }
    close() { this.readyState = 3; this.onclose?.() }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
  }
  globalThis.window = { setTimeout, clearTimeout }
  globalThis.WebSocket = FakeWebSocket
  try {
    const errors = []
    const handlers = { onStatus() {}, onQuote() {}, onStats() {}, onError: (message) => errors.push(message) }
    const stop = connectMarketStream(Array.from({ length: 205 }, (_, index) => ({ symbol: `PAIR${index}` })), handlers)
    const socket = sockets[0]
    assert.match(socket.url, /:443\/ws$/)
    socket.open()
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.deepEqual(socket.sent.map((request) => request.params.length), [100, 100, 5])
    socket.message({ id: 42, code: 2, msg: 'Invalid request' })
    assert.match(errors[0], /Binance rechazó la suscripción/)
    stop()
  } finally {
    globalThis.window = previousWindow
    globalThis.WebSocket = previousWebSocket
  }
})
