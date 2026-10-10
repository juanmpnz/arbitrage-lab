import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor } from '../server/execution.mjs'
import { createBinanceReader } from '../server/binance.mjs'
const rules = [{ filterType: 'PRICE_FILTER', minPrice: '.0001', maxPrice: '10000', tickSize: '.0001' }, { filterType: 'LOT_SIZE', minQty: '.0001', maxQty: '10000', stepSize: '.0001' }, { filterType: 'MIN_NOTIONAL', minNotional: '5' }]
const markets = [
  { symbol: 'AUSDS', baseAsset: 'A', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'], filters: rules },
  { symbol: 'BA', baseAsset: 'B', quoteAsset: 'A', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'], filters: rules },
  { symbol: 'BUSDS', baseAsset: 'B', quoteAsset: 'USDS', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'], filters: rules },
]
const input = { symbols: ['AUSDS', 'BA', 'BUSDS'], amount: 6.6 }
function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-execution-')), file = join(dir, 'execution.json')
  const calls = []
  let clock = 1000
  const reader = {
    environment: 'live', account: async () => ({ environment: 'live', canTrade: true, balances: [{ asset: 'USDS', free: '7.35', locked: '0' }] }),
    markets: async () => ({ environment: 'live', symbols: markets }),
    commission: async () => ({ standardCommission: { taker: '.001', buyer: '0', seller: '0' }, specialCommission: { taker: '0', buyer: '0', seller: '0' }, taxCommission: { taker: '0', buyer: '0', seller: '0' } }),
    book: async symbol => ({ bidPrice: symbol === 'BUSDS' ? '1.02' : '1', askPrice: symbol === 'BUSDS' ? '1.03' : '1', bidQty: '100', askQty: '100', receivedAt: clock }),
    testOrder: async order => { assert.equal(order.timeInForce, 'FOK') },
    placeOrder: async order => {
      calls.push(order)
      const received = order.side === 'BUY' ? Number(order.quantity) : Number(order.quantity) * Number(order.price)
      const market = markets.find(m => m.symbol === order.symbol)
      return { orderId: calls.length, status: 'FILLED', executedQty: order.quantity, cummulativeQuoteQty: String(Number(order.quantity) * Number(order.price)), fills: [{ qty: order.quantity, commission: String(received * .001), commissionAsset: order.side === 'BUY' ? market.baseAsset : market.quoteAsset }] }
    },
    queryOrder: async () => ({ status: 'FILLED' }), ...overrides,
  }
  const executor = createExecutor({ reader, file, enabled: true, now: () => clock })
  return { executor, reader, calls, file, clock: value => { clock = value }, close: () => rmSync(dir, { recursive: true, force: true }) }
}
test('disabled execution and invalid budget do not place orders', async () => {
  const s = setup()
  try {
    const disabled = createExecutor({ reader: s.reader, file: s.file })
    await assert.rejects(disabled.preview(input), /desactivado/)
    await assert.rejects(s.executor.preview({ ...input, amount: 7 }), /6,6/)
    assert.equal(s.calls.length, 0)
  } finally { s.close() }
})
test('executes three FOK legs using actual received amounts minus commissions and persists the budget', async () => {
  const s = setup()
  try {
    const preview = await s.executor.preview(input)
    assert.equal(s.calls.length, 0)
    const run = await s.executor.execute(preview.token)
    assert.equal(run.status, 'COMPLETED', run.message)
    assert.equal(s.calls.length, 3)
    assert.ok(Number(s.calls[1].quantity) < Number(s.calls[0].quantity))
    assert.ok(run.holdings.USDS > input.amount)
    assert.equal(new Set(s.calls.map(c => c.newClientOrderId)).size, 3)
    assert.ok(s.executor.status().reserved <= 7)
    const restarted = createExecutor({ reader: s.reader, file: s.file, enabled: true })
    await assert.rejects(restarted.preview(input), /Presupuesto acumulado/)
    await assert.rejects(s.executor.execute(preview.token), /caducada/)
  } finally { s.close() }
})
test('rejects expired tokens and prevents concurrent or repeated execution', async () => {
  const s = setup()
  try {
    const preview = await s.executor.preview(input); s.clock(17000)
    await assert.rejects(s.executor.execute(preview.token), /caducada/)
    s.clock(18000)
    const next = await s.executor.preview(input)
    const first = s.executor.execute(next.token)
    await assert.rejects(s.executor.execute(next.token), /ocupado/)
    await first
    assert.equal(s.calls.length, 3)
  } finally { s.close() }
})
test('ambiguous submission is queried once and never resubmitted or advanced', async () => {
  let sends = 0, queries = 0
  const s = setup({ placeOrder: async () => { sends++; throw new Error('timeout') }, queryOrder: async () => { queries++; return { status: 'FILLED' } } })
  try {
    const preview = await s.executor.preview(input), run = await s.executor.execute(preview.token)
    assert.equal(run.status, 'REVIEW'); assert.equal(sends, 1); assert.equal(queries, 1)
    await assert.rejects(s.executor.preview({ ...input, amount: 1 }), /revisión/)
    const restarted = createExecutor({ reader: s.reader, file: s.file, enabled: true })
    await assert.rejects(restarted.preview(input), /revisión/)
  } finally { s.close() }
})
test('partial execution stops before the second leg and records its response for review', async () => {
  let sends = 0
  const s = setup({ placeOrder: async () => { sends++; return { status: 'PARTIALLY_FILLED', executedQty: '1', fills: [] } } })
  try {
    const run = await s.executor.execute((await s.executor.preview(input)).token)
    assert.equal(run.status, 'REVIEW'); assert.equal(sends, 1)
    assert.equal(run.legs[0].result.status, 'PARTIALLY_FILLED')
  } finally { s.close() }
})
test('signs trade requests as POST, never caches them, and reads order status with GET', async () => {
  const calls = []
  const reader = createBinanceReader({ apiKey: 'key', apiSecret: 'secret', now: () => 1000, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => url.includes('/time?') ? { serverTime: 1000 } : { status: 'FILLED' } }
  } })
  const order = { symbol: 'BTCUSDS', side: 'BUY', type: 'LIMIT', timeInForce: 'FOK', price: '1', quantity: '1', newClientOrderId: 'test-only' }
  await reader.placeOrder(order); await reader.placeOrder(order); await reader.queryOrder(order.symbol, order.newClientOrderId)
  assert.deepEqual(calls.map(c => c.options.method), ['GET', 'POST', 'POST', 'GET'])
  assert.ok(calls[1].url.includes('signature='))
  assert.equal(calls[1].options.headers['X-MBX-APIKEY'], 'key')
})

test('loss of profitability after the first fill stops the cycle and preserves the order for review', async () => {
  let sent = false
  const s = setup()
  const originalPlace = s.reader.placeOrder, originalBook = s.reader.book
  s.reader.placeOrder = async order => { const result = await originalPlace(order); sent = true; return result }
  s.reader.book = async symbol => sent && symbol === 'BUSDS' ? { ...await originalBook(symbol), bidPrice: '.9' } : originalBook(symbol)
  try {
    const run = await s.executor.execute((await s.executor.preview(input)).token)
    assert.equal(run.status, 'REVIEW'); assert.equal(s.calls.length, 1)
    assert.match(run.message, /rentabilidad/)
    assert.ok(run.holdings.A > 0)
  } finally { s.close() }
})

test('manual stop prevents subsequent legs and reconciliation only queries orders', async () => {
  const s = setup({ orderTrades: async () => [] })
  const original = s.reader.placeOrder
  s.reader.placeOrder = async order => { const result = await original(order); s.executor.stop(); return result }
  try {
    const run = await s.executor.execute((await s.executor.preview(input)).token)
    assert.equal(run.status, 'REVIEW'); assert.equal(s.calls.length, 1)
    await s.executor.reconcile(run.id)
    assert.equal(s.calls.length, 1)
    assert.equal(run.legs[0].reconciled.status, 'FILLED')
  } finally { s.close() }
})

test('HTTP execution routes require JSON, reject cross-site access and expose configured state', async () => {
  const { createApiServer } = await import('../server/index.mjs')
  let calls = 0
  const executor = { status: () => ({ enabled: false }), preview: async () => { calls++; return { token: 'mock' } }, execute: async () => { calls++; return {} } }
  const server = createApiServer({ configured: false, environment: 'live' }, null, executor)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    assert.equal((await fetch(`${base}/api/execution/run`, { ...options, headers: { ...options.headers, Origin: 'https://evil.example' } })).status, 403)
    assert.equal(calls, 0)
    assert.equal((await fetch(`${base}/api/execution/run`, { ...options, headers: { 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal((await (await fetch(`${base}/api/execution`)).json()).enabled, false)
    assert.equal((await fetch(`${base}/api/execution/preview`, options)).status, 200)
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('two executor instances sharing a journal cannot spend the same budget concurrently', async () => {
  const s = setup()
  try {
    const second = createExecutor({ reader: s.reader, file: s.file, enabled: true, now: () => 1000 })
    const one = await s.executor.preview(input), two = await second.preview(input)
    const first = s.executor.execute(one.token)
    await assert.rejects(second.execute(two.token), /ocupado|revisión|bloqueado/)
    await first
    assert.equal(s.calls.length, 3)
  } finally { s.close() }
})

test('a failed pre-send test releases its reservation without placing an order', async () => {
  let checks = 0
  const s = setup({ testOrder: async () => { if (++checks > 1) throw new Error('Trade permission rejected') } })
  try {
    const run = await s.executor.execute((await s.executor.preview(input)).token)
    assert.equal(run.status, 'STOPPED'); assert.equal(s.calls.length, 0)
    assert.equal(s.executor.status().reserved, 0)
  } finally { s.close() }
})
