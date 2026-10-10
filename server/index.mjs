import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ApiError, createBinanceReader } from './binance.mjs'
import { createOpportunityStore } from './opportunities.mjs'

export function createApiServer(reader, history = null) {
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(JSON.stringify(data))
    }
    const localHost = value => { try { return ['localhost', '127.0.0.1'].includes(new URL(value).hostname) } catch { return false } }
    if (!localHost(`http://${req.headers.host}`) || (req.headers.origin && !localHost(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'El backend solo admite acceso local.' })
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'POST' && url.pathname === '/api/opportunities') {
        if (!history) return send(503, { error: 'Historial no configurado.' })
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Se requiere application/json.' })
        let body = ''; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 1048576) return send(413, { error: 'Observación demasiado grande.' }); body += chunk.toString() }
        let data
        try { data = JSON.parse(body) } catch { return send(400, { error: 'JSON inválido.' }) }
        return send(200, history.observe(data))
      }
      if (req.method !== 'GET') return send(405, { error: 'Solo se permiten consultas y registro local de oportunidades.' })
      if (url.pathname === '/api/opportunities') return history ? send(200, { records: history.list() }) : send(503, { error: 'Historial no configurado.' })
      if (url.pathname === '/api/health') return send(200, { mode: 'read-only', configured: reader.configured, environment: reader.environment })
      if (url.pathname === '/api/markets') return send(200, await reader.markets())
      if (url.pathname === '/api/reference-price') return send(200, await reader.referencePrice(url.searchParams.get('symbol') ?? ''))
      if (url.pathname === '/api/account') return send(200, await reader.account())
      if (url.pathname === '/api/commission') return send(200, await reader.commission(url.searchParams.get('symbol') ?? ''))
      return send(404, { error: 'Endpoint no disponible.' })
    } catch (error) { return send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Error interno del backend.' }) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const port = Number(process.env.API_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('API_PORT debe ser un puerto entre 1024 y 65535.')
  const reader = createBinanceReader({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, testnet: process.env.BINANCE_TESTNET === 'true' })
  const history = createOpportunityStore(resolve('data/opportunities.json'))
  const server = createApiServer(reader, history)
  server.listen(port, '127.0.0.1', () => console.log(`Backend de lectura en http://127.0.0.1:${port} (${reader.environment}, claves ${reader.configured ? 'configuradas' : 'pendientes'})`))
}
