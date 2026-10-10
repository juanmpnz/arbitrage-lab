import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpportunityStore } from '../server/opportunities.mjs'
import { createApiServer } from '../server/index.mjs'
const config = { startAsset: 'USDS', amount: 7, feeMode: 'account', feeBps: 10, slippageBps: 5, minNetBps: 1 }
const signal = { route: ['USDS', 'BTC', 'ETH', 'USDS'], symbols: ['BTCUSDS', 'ETHBTC', 'ETHUSDS'], input: 7, output: 7.007, netBps: 10, oldestQuoteMs: 200 }
const batch = (capturedAt, opportunities = [signal], params = config) => ({ sessionId: 'test-session', snapshots: [{ capturedAt, config: params, opportunities }] })

test('persists a continuous signal as one episode with its best return and observed duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-history-')); const file = join(dir, 'data', 'history.json')
  let clock = 1000
  try {
    const store = createOpportunityStore(file, () => clock)
    store.observe(batch(clock)); clock = 1500
    store.observe(batch(clock, [{ ...signal, output: 7.014, netBps: 20 }]))
    const [record] = store.list()
    assert.equal(store.list().length, 1)
    assert.equal(record.observations, 2)
    assert.equal(record.durationMs, 500)
    assert.equal(record.bestNetBps, 20)
    assert.equal(record.bestOutput, 7.014)
    assert.equal(record.active, true)
    assert.equal(createOpportunityStore(file, () => clock).list()[0].active, false)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('disappearance, gaps and changed parameters produce distinct episodes; retries are idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-history-')); let clock = 1000
  try {
    const store = createOpportunityStore(join(dir, 'history.json'), () => clock)
    store.observe(batch(clock)); store.observe(batch(clock))
    assert.equal(store.list()[0].observations, 1)
    clock = 1500; store.observe(batch(clock, []))
    assert.equal(store.list()[0].active, false)
    clock = 2000; store.observe(batch(clock))
    clock = 2500; store.observe(batch(clock, [signal], { ...config, slippageBps: 10 }))
    assert.equal(store.list().length, 3)
    clock = 9000
    assert.equal(store.list()[0].active, false)
    store.observe(batch(clock, [signal], { ...config, slippageBps: 10 }))
    assert.equal(store.list().length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('rejects malformed and stale observations atomically and ignores extra fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-history-'))
  try {
    const store = createOpportunityStore(join(dir, 'history.json'), () => 1000)
    assert.throws(() => store.observe(batch(1000, [{ ...signal, netBps: 100 }])), /Señal inválida/)
    assert.throws(() => store.observe(batch(-100000)), /antigua/)
    assert.equal(store.list().length, 0)
    store.observe(batch(1000, [{ ...signal, secret: 'must-not-persist' }]))
    assert.equal(JSON.stringify(store.list()).includes('must-not-persist'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('accepts JSON observations locally but keeps exchange write endpoints and cross-site requests blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arbitrage-history-'))
  const store = createOpportunityStore(join(dir, 'history.json'), () => 1000)
  const server = createApiServer({ configured: false, environment: 'live' }, store)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch(1000)) }
  try {
    assert.equal((await fetch(`${base}/api/opportunities`, options)).status, 200)
    const data = await (await fetch(`${base}/api/opportunities`)).json()
    assert.equal(data.records.length, 1)
    assert.equal((await fetch(`${base}/api/opportunities`, { ...options, headers: { ...options.headers, Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(`${base}/api/order`, options)).status, 405)
    assert.equal((await fetch(`${base}/api/opportunities`, { ...options, headers: { 'Content-Type': 'text/plain' } })).status, 415)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }) }
})
