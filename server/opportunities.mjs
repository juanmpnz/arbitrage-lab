import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ApiError } from './binance.mjs'

const MAX_RECORDS = 1000
const asset = value => typeof value === 'string' && /^[A-Z0-9]{1,30}$/.test(value)
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0
export function createOpportunityStore(file, now = Date.now) {
  let records = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  if (!Array.isArray(records)) throw new Error('El historial de oportunidades no es válido.')
  // An interrupted browser/server does not establish that a signal stayed available.
  records = records.slice(-MAX_RECORDS).map(record => ({ ...record, active: false }))
  const sessionTimes = new Map()
  return {
    list() {
      return records.slice().reverse().map(record => ({ ...record, active: record.active && now() - record.lastSeenAt <= 5000, durationMs: record.lastSeenAt - record.firstSeenAt }))
    },
    observe(body) {
      if (!body || typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,50}$/.test(body.sessionId) || !Array.isArray(body.snapshots) || body.snapshots.length > 20) throw new ApiError(400, 'Formato de historial inválido.')
      // Validate the whole batch before changing persistent state.
      const snapshots = body.snapshots.map(snapshot => {
        if (!snapshot || !Number.isFinite(snapshot.capturedAt) || Math.abs(snapshot.capturedAt - now()) > 60_000 || !Array.isArray(snapshot.opportunities) || snapshot.opportunities.length > 50) throw new ApiError(400, 'Observación inválida o demasiado antigua.')
        const config = snapshot.config
        if (!config || !['account', 'manual'].includes(config.feeMode) || !asset(config.startAsset) || !positive(config.amount) || !Number.isFinite(config.slippageBps) || config.slippageBps < 0 || config.slippageBps >= 10000 || !Number.isFinite(config.minNetBps) || config.minNetBps < 0 || (config.feeMode === 'manual' && (!Number.isFinite(config.feeBps) || config.feeBps < 0 || config.feeBps >= 10000))) throw new ApiError(400, 'Parámetros de observación inválidos.')
        const cleanConfig = { feeMode: config.feeMode, startAsset: config.startAsset, amount: config.amount, slippageBps: config.slippageBps, minNetBps: config.minNetBps, feeBps: config.feeMode === 'manual' ? config.feeBps : null }
        const opportunities = snapshot.opportunities.map(item => {
          if (!item || !Array.isArray(item.route) || item.route.length !== 4 || !item.route.every(asset) || item.route[0] !== config.startAsset || item.route[0] !== item.route[3] || !Array.isArray(item.symbols) || item.symbols.length !== 3 || !item.symbols.every(asset) || new Set(item.symbols).size !== 3 || !positive(item.input) || item.input !== config.amount || !positive(item.output) || item.output <= item.input || !positive(item.netBps) || Math.abs(item.netBps - (item.output / item.input - 1) * 10000) > .001 || !Number.isFinite(item.oldestQuoteMs) || item.oldestQuoteMs < 0 || item.oldestQuoteMs > 2000) throw new ApiError(400, 'Señal inválida.')
          if (item.grossOutput !== undefined && (!positive(item.grossOutput) || item.grossOutput < item.output)) throw new ApiError(400, 'Costo estimado inválido.')
          if (item.legFeeBps !== undefined && (!Array.isArray(item.legFeeBps) || item.legFeeBps.length !== 3 || !item.legFeeBps.every(value => Number.isFinite(value) && value >= 0 && value < 10000))) throw new ApiError(400, 'Tarifas inválidas.')
          return { grossOutput: item.grossOutput, legFeeBps: item.legFeeBps, route: item.route, symbols: item.symbols, input: item.input, output: item.output, netBps: item.netBps, oldestQuoteMs: item.oldestQuoteMs }
        })
        return { capturedAt: snapshot.capturedAt, config: cleanConfig, opportunities }
      })
      let latest = sessionTimes.get(body.sessionId) ?? 0
      const next = records.map(record => ({ ...record }))
      for (const snapshot of snapshots) {
        if (snapshot.capturedAt <= latest) continue
        latest = snapshot.capturedAt
        const seen = new Set()
        for (const item of snapshot.opportunities) {
          const key = JSON.stringify([body.sessionId, snapshot.config, item.route, item.symbols])
          if (seen.has(key)) continue
          seen.add(key)
          let record = next.findLast(record => record.key === key && record.active && snapshot.capturedAt - record.lastSeenAt <= 5000)
          if (!record) {
            record = { id: randomUUID(), key, sessionId: body.sessionId, firstSeenAt: snapshot.capturedAt, lastSeenAt: snapshot.capturedAt, active: true, observations: 0, config: snapshot.config, ...item, bestNetBps: item.netBps, bestOutput: item.output }
            next.push(record)
          }
          Object.assign(record, item, { lastSeenAt: snapshot.capturedAt, observations: record.observations + 1, bestNetBps: Math.max(record.bestNetBps, item.netBps), bestOutput: Math.max(record.bestOutput, item.output) })
        }
        for (const record of next) if (record.sessionId === body.sessionId && record.active && !seen.has(record.key)) record.active = false
      }
      const kept = next.slice(-MAX_RECORDS)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(kept), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
      records = kept
      sessionTimes.set(body.sessionId, latest)
      if (sessionTimes.size > 100) sessionTimes.delete(sessionTimes.keys().next().value)
      return { stored: records.length }
    },
  }
}
