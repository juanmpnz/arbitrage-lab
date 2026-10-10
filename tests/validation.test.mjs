import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateRoute, floorStep } from '../src/core/validation.ts'
const now = 100_000
const filters = [{ filterType: 'LOT_SIZE', minQty: '.00000001', maxQty: '10000', stepSize: '.00000001' }, { filterType: 'MIN_NOTIONAL', minNotional: '5', applyToMarket: true, avgPriceMins: 5 }]
const markets = [
  { symbol: 'AUSDS', baseAsset: 'A', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, filters },
  { symbol: 'BA', baseAsset: 'B', quoteAsset: 'A', status: 'TRADING', isSpotTradingAllowed: true, filters },
  { symbol: 'BUSDS', baseAsset: 'B', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, filters },
  { symbol: 'BNBUSDS', baseAsset: 'BNB', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, filters },
]
const books = new Map(markets.map(m => [m.symbol, { symbol: m.symbol, bidPrice: m.symbol === 'BUSDS' ? '1.02' : '1', askPrice: m.symbol === 'BUSDS' ? '1.03' : '1', bidQty: '1000', askQty: '1000', receivedAt: now }]))
const rates = { maker: '.001', taker: '.001', buyer: '0', seller: '0' }
const zero = { maker: '0', taker: '0', buyer: '0', seller: '0' }
const commissions = new Map(markets.map(m => [m.symbol, { symbol: m.symbol, fetchedAt: now, standardCommission: rates, specialCommission: zero, taxCommission: zero, discount: { enabledForAccount: false, enabledForSymbol: true, discountAsset: 'BNB', discount: '.75' } }]))
const account = { environment: 'live', fetchedAt: now, canTrade: true, accountType: 'SPOT', balances: [{ asset: 'USDS', free: '10', locked: '100' }, { asset: 'BNB', free: '1', locked: '0' }] }
const referencePrices = new Map(markets.map(m => [m.symbol, { price: '1', mins: 5, lastPrice: '1', fetchedAt: now }]))
const context = { account, commissions, referencePrices, now, slippageBps: 0, minNetBps: 1 }
const route = { route: ['USDS', 'A', 'B', 'USDS'], symbols: ['AUSDS', 'BA', 'BUSDS'], input: 10, output: 10.2, netBps: 200, oldestQuoteMs: 0 }

test('validates a funded USDS cycle with account costs on all three legs', () => {
  const result = validateRoute(route, markets, books, context)
  assert.ok(result.opportunity)
  assert.ok(result.opportunity.output < 10.2)
  assert.ok(Math.abs(result.opportunity.output - 10.2 * .999 ** 3) < 1e-7)
})
test('locked funds do not satisfy balance, stale account and testnet fail closed', () => {
  assert.match(validateRoute({ ...route, input: 11 }, markets, books, context).reason, /Saldo disponible/)
  assert.match(validateRoute(route, markets, books, { ...context, now: now + 61000 }).reason, /Saldo pendiente/)
  assert.match(validateRoute(route, markets, books, { ...context, account: { ...account, environment: 'testnet' } }).reason, /Testnet/)
  assert.match(validateRoute(route, markets, books, { ...context, account: { ...account, canTrade: false } }).reason, /permiso/)
})
test('missing tariffs, exchange filters and reference prices never use optimistic defaults', () => {
  assert.match(validateRoute(route, markets, books, { ...context, commissions: new Map() }).reason, /comisión pendiente/)
  assert.match(validateRoute(route, markets.map(m => ({ ...m, filters: [] })), books, context).reason, /reglas pendientes/)
  assert.match(validateRoute(route, markets, books, { ...context, referencePrices: new Map() }).reason, /precio promedio/)
  const stale = new Map(commissions); stale.set('AUSDS', { ...stale.get('AUSDS'), fetchedAt: now - 61000 })
  assert.match(validateRoute(route, markets, books, { ...context, commissions: stale }).reason, /comisión pendiente/)
})
test('checks min notional on intermediate legs after deductions and rounds down', () => {
  const tighter = markets.map(m => m.symbol === 'BA' ? { ...m, filters: [filters[0], { ...filters[1], minNotional: '10' }] } : m)
  assert.match(validateRoute(route, tighter, books, context).reason, /BA: importe inferior/)
  assert.equal(floorStep(1.239, '.01'), 1.23)
  const tooSmall = markets.map(m => ({ ...m, filters: [{ ...filters[0], minQty: '20' }] }))
  assert.match(validateRoute(route, tooSmall, books, context).reason, /cantidad fuera/)
})
test('BNB factor .75 reduces fees by 25%, but only with enabled discount and sufficient free BNB', () => {
  const discounted = new Map([...commissions].map(([s, c]) => [s, { ...c, discount: { ...c.discount, enabledForAccount: true } }]))
  const ordinary = validateRoute(route, markets, books, context).opportunity.output
  const result = validateRoute(route, markets, books, { ...context, commissions: discounted }).opportunity
  // First two assets have no direct BNB conversion, so remain conservatively undiscounted.
  assert.ok(result.output > ordinary)
  assert.ok(Math.abs(result.output - 10.2 * .999 ** 2 * .99925) < 1e-7)
  const noBNB = { ...account, balances: account.balances.filter(b => b.asset !== 'BNB') }
  assert.equal(validateRoute(route, markets, books, { ...context, account: noBNB, commissions: discounted }).opportunity.output, ordinary)
})
test('special and tax rates are added with side rates and never discounted', () => {
  const extra = new Map([...commissions].map(([s, c]) => [s, { ...c, taxCommission: { ...zero, taker: '.002', buyer: '.001' } }]))
  const result = validateRoute(route, markets, books, { ...context, commissions: extra })
  assert.ok(result.opportunity, JSON.stringify(result))
  assert.ok(result.opportunity.output < validateRoute(route, markets, books, context).opportunity.output)
  assert.match(validateRoute(route, markets, books, { ...context, minNetBps: 500 }).reason, /Beneficio insuficiente/)
})
