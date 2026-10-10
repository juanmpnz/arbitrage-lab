import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { createBinanceReader } from '../server/binance.mjs'
import { createApiServer } from '../server/index.mjs'

test('signs account requests with server time, projects balances and caches reads', async () => {
  const calls = []
  const reader = createBinanceReader({ apiKey: 'test-key', apiSecret: 'test-secret', now: () => 1000, fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => url.includes('/time?') ? { serverTime: 2000 } : { uid: 'private-id', accountType: 'SPOT', balances: [{ asset: 'USDT', free: '68', locked: '2' }, { asset: 'BTC', free: '0', locked: '0' }] } }
  } })
  const account = await reader.account()
  assert.deepEqual(account.balances, [{ asset: 'USDT', free: '68', locked: '2' }])
  assert.equal(account.uid, undefined)
  const signed = new URL(calls[1].url)
  const signature = signed.searchParams.get('signature')
  signed.searchParams.delete('signature')
  assert.equal(signed.searchParams.get('timestamp'), '2000')
  assert.equal(signature, createHmac('sha256', 'test-secret').update(signed.searchParams.toString()).digest('hex'))
  assert.equal(calls[1].options.headers['X-MBX-APIKEY'], 'test-key')
  await reader.account()
  assert.equal(calls.length, 2)
})

test('requires credentials, validates symbols and sanitizes upstream errors', async () => {
  await assert.rejects(createBinanceReader({}).account(), /Configura BINANCE_API_KEY/)
  let calls = 0
  const reader = createBinanceReader({ apiKey: 'key', apiSecret: 'secret', fetchImpl: async url => {
    calls++
    return { ok: url.includes('/time?'), status: 401, json: async () => url.includes('/time?') ? { serverTime: Date.now() } : { code: -2015, msg: 'sensitive upstream text' } }
  } })
  await assert.rejects(reader.commission('../order'), /símbolo válido/)
  assert.equal(calls, 0)
  await assert.rejects(reader.account(), error => error.message.includes('permisos de lectura') && !error.message.includes('sensitive'))
})

test('uses testnet only when configured and queries commission separately', async () => {
  const urls = []
  const reader = createBinanceReader({ apiKey: 'key', apiSecret: 'secret', testnet: true, fetchImpl: async url => {
    urls.push(url)
    return { ok: true, json: async () => url.includes('/time?') ? { serverTime: Date.now() } : { symbol: 'BTCUSDT', standardCommission: { taker: '0.001' } } }
  } })
  assert.equal((await reader.commission('BTCUSDT')).standardCommission.taker, '0.001')
  assert.ok(urls.every(url => url.startsWith('https://testnet.binance.vision/')))
  assert.ok(urls[1].includes('/api/v3/account/commission?symbol=BTCUSDT'))
})

test('local HTTP API never accepts write methods or cross-site requests', async () => {
  let calls = 0
  const server = createApiServer({ configured: true, environment: 'live', account: async () => { calls++; return { balances: [] } }, commission: async () => ({}) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${base}/api/account`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/api/account`, { headers: { Origin: 'https://evil.example' } })).status, 403)
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/account`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(hostileHostStatus, 403)
    assert.equal((await fetch(`${base}/api/order`)).status, 404)
    assert.equal(calls, 0)
    const response = await fetch(`${base}/api/account`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
