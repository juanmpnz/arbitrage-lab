import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ApiError, createBinanceReader } from './binance.mjs'

export function createApiServer(reader) {
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(JSON.stringify(data))
    }
    const localHost = value => { try { return ['localhost', '127.0.0.1'].includes(new URL(value).hostname) } catch { return false } }
    if (!localHost(`http://${req.headers.host}`) || (req.headers.origin && !localHost(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'El backend solo admite acceso local.' })
    if (req.method !== 'GET') return send(405, { error: 'Solo se permiten consultas GET.' })
    const url = new URL(req.url, 'http://localhost')
    try {
      if (url.pathname === '/api/health') return send(200, { mode: 'read-only', configured: reader.configured, environment: reader.environment })
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
  const server = createApiServer(reader)
  server.listen(port, '127.0.0.1', () => console.log(`Backend de lectura en http://127.0.0.1:${port} (${reader.environment}, claves ${reader.configured ? 'configuradas' : 'pendientes'})`))
}
