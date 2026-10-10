import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutomaticWorker, buildCycles, grossCandidates } from '../server/automatic.mjs'
const markets = [
  { symbol: 'BTCUSDS', baseAsset: 'BTC', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'] },
  { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'] },
  { symbol: 'ETHUSDS', baseAsset: 'ETH', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'] },
]
function setup(overrides = {}) {
  const sockets = [], events = []
  let reserved = 0, stopped = false, busy = false
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); this.readyState = 0 }
    open() { this.readyState = 1; this.onopen?.() }
    send(data) { events.push(['subscribe', JSON.parse(data)]) }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const reader = { environment: 'live', markets: async () => ({ symbols: markets }) }
  const executor = {
    status: () => ({ enabled: true, busy, stopped, reserved, limit: 7, runs: [] }),
    preview: async input => { events.push(['preview', input]); return { token: 'server-token', output: 6.61, quoteAgeMs: 0 } },
    execute: async token => { events.push(['execute', token]); reserved = 6.93; return { status: 'COMPLETED' } },
    stop: () => { stopped = true }, ...overrides,
  }
  const worker = createAutomaticWorker({ reader, executor, history: { observe: body => events.push(['history', body]) }, enabled: true, now: () => 1000, WebSocketImpl: Socket })
  const feed = async () => {
    worker.start(); await new Promise(resolve => setImmediate(resolve))
    const socket = sockets[0]; socket.open()
    for (const m of markets) socket.message({ s: m.symbol, b: m.symbol === 'ETHUSDS' ? '1.02' : '1', a: m.symbol === 'ETHUSDS' ? '1.03' : '1', B: '100', A: '100' })
    return socket
  }
  return { worker, events, sockets, feed, busy: value => { busy = value } }
}
test('automatically selects, validates, records and executes a backend route without a browser', async () => {
  const s = setup()
  try {
    const socket = await s.feed()
    assert.match(socket.url, /stream.binance.com:443/)
    await s.worker.evaluate()
    assert.equal(s.events.filter(e => e[0] === 'execute').length, 1)
    assert.deepEqual(s.events.find(e => e[0] === 'preview')[1].symbols, ['BTCUSDS', 'ETHBTC', 'ETHUSDS'])
    assert.equal(s.events.find(e => e[0] === 'history')[1].snapshots[0].config.feeMode, 'account')
    assert.equal(s.worker.status().running, false)
    await s.worker.evaluate()
    assert.equal(s.events.filter(e => e[0] === 'execute').length, 1)
  } finally { s.worker.stop() }
})
test('failed net validation never sends an order and cooldown avoids immediate repeated requests', async () => {
  let previews = 0
  const s = setup({ preview: async () => { previews++; throw new Error('Beneficio insuficiente') } })
  try {
    await s.feed(); await s.worker.evaluate(); await s.worker.evaluate()
    assert.equal(previews, 1)
    assert.equal(s.events.filter(e => e[0] === 'execute').length, 0)
    assert.match(s.worker.status().lastReason, /Beneficio/)
  } finally { s.worker.stop() }
})
test('a review result halts the automatic worker; busy execution skips scanning', async () => {
  const s = setup({ execute: async () => ({ status: 'REVIEW', message: 'timeout incierto' }) })
  try {
    await s.feed(); s.busy(true); await s.worker.evaluate()
    assert.equal(s.events.filter(e => e[0] === 'preview').length, 0)
    s.busy(false); await s.worker.evaluate()
    assert.equal(s.worker.status().running, false)
    assert.match(s.worker.status().lastReason, /REVIEW/)
  } finally { s.worker.stop() }
})
test('gross scanner rejects stale quotes and insufficient top-level capacity', () => {
  const cycles = buildCycles(markets, 'USDS')
  const books = new Map(markets.map(m => [m.symbol, { bidPrice: m.symbol === 'ETHUSDS' ? '1.02' : '1', askPrice: '1', bidQty: '100', askQty: '100', receivedAt: 1000 }]))
  assert.equal(grossCandidates(cycles, books, 6.6, 3500).length, 0)
  books.set('BTCUSDS', { ...books.get('BTCUSDS'), askQty: '1' })
  assert.equal(grossCandidates(cycles, books, 6.6, 1500).length, 0)
})
test('disabling automatic mode or trading prevents subscriptions and execution', () => {
  const status = { enabled: false }
  const worker = createAutomaticWorker({ reader: { environment: 'live' }, executor: { status: () => status }, enabled: true })
  worker.start()
  assert.equal(worker.status().running, false)
  assert.match(worker.status().lastReason, /BINANCE_TRADING_ENABLED/)
})
