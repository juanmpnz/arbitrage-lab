import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findOpportunities } from '../src/core/arbitrage.ts'

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
