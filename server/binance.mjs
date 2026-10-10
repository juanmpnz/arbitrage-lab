import { createHmac } from 'node:crypto'

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function createBinanceReader({ apiKey, apiSecret, testnet = false, fetchImpl = fetch, now = Date.now }) {
  const base = testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com'
  let offset = 0
  let clockCheckedAt = -Infinity
  const cache = new Map()
  const pending = new Map()
  async function request(path, params, signed = false) {
    const query = new URLSearchParams(params)
    if (signed) {
      query.set('timestamp', String(Math.round(now() + offset)))
      query.set('recvWindow', '5000')
      query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'))
    }
    let response
    try {
      response = await fetchImpl(`${base}${path}?${query}`, { headers: signed ? { 'X-MBX-APIKEY': apiKey } : {}, signal: AbortSignal.timeout(10_000) })
    } catch { throw new ApiError(502, 'No se pudo contactar con Binance. Comprueba la conexión del backend.') }
    let data
    try { data = await response.json() } catch { throw new ApiError(502, 'Binance devolvió una respuesta inválida.') }
    if (!response.ok) {
      const messages = {
        '-2015': 'Binance rechazó la clave: comprueba permisos de lectura, IP autorizada y entorno.',
        '-2014': 'La API key de Binance tiene un formato inválido.',
        '-1022': 'La firma no es válida. Comprueba el API secret.',
        '-1021': 'El reloj está fuera del margen permitido por Binance. Reinicia el backend.',
        '-1121': 'Este símbolo no está disponible en el entorno seleccionado.',
      }
      const message = response.status === 429 || response.status === 418 ? 'Binance limitó las consultas. Espera antes de volver a intentar.' : messages[String(data.code)] ?? `Binance rechazó la consulta (código ${Number.isFinite(data.code) ? data.code : response.status}).`
      throw new ApiError(502, message)
    }
    return data
  }
  async function signed(path, params, ttl) {
    if (!apiKey || !apiSecret) throw new ApiError(503, 'Configura BINANCE_API_KEY y BINANCE_API_SECRET en el .env del backend y reinícialo.')
    const key = `${path}:${JSON.stringify(params)}`
    const cached = cache.get(key)
    if (cached && now() - cached.at < ttl) return cached.value
    if (pending.has(key)) return pending.get(key)
    const operation = (async () => {
      if (now() - clockCheckedAt > 60_000) {
        const started = now()
        const time = await request('/api/v3/time', {})
        if (!Number.isFinite(time.serverTime)) throw new ApiError(502, 'Binance no proporcionó la hora del servidor.')
        offset = time.serverTime - (started + now()) / 2
        clockCheckedAt = now()
      }
      const value = await request(path, params, true)
      cache.set(key, { at: now(), value })
      return value
    })()
    pending.set(key, operation)
    try { return await operation } finally { pending.delete(key) }
  }
  return {
    configured: Boolean(apiKey && apiSecret),
    environment: testnet ? 'testnet' : 'live',
    async markets() {
      const key = 'markets'
      const cached = cache.get(key)
      if (cached && now() - cached.at < 60_000) return cached.value
      const info = await request('/api/v3/exchangeInfo', {})
      const value = { environment: testnet ? 'testnet' : 'live', symbols: info.symbols }
      cache.set(key, { at: now(), value })
      return value
    },
    async referencePrice(symbol) {
      if (!/^[A-Z0-9]{2,30}$/.test(symbol)) throw new ApiError(400, 'Símbolo inválido.')
      const key = `price:${symbol}`
      const cached = cache.get(key)
      if (cached && now() - cached.at < 15_000) return cached.value
      const data = await request('/api/v3/avgPrice', { symbol })
      const ticker = await request('/api/v3/ticker/price', { symbol })
      const value = { price: data.price, lastPrice: ticker.price, mins: data.mins, fetchedAt: now() }
      cache.set(key, { at: now(), value })
      return value
    },
    async account() {
      const data = await signed('/api/v3/account', { omitZeroBalances: 'true' }, 15_000)
      return { environment: testnet ? 'testnet' : 'live', fetchedAt: now(), canTrade: data.canTrade, accountType: data.accountType, balances: (data.balances ?? []).filter(item => Number(item.free) > 0 || Number(item.locked) > 0).map(({ asset, free, locked }) => ({ asset, free, locked })) }
    },
    async commission(symbol) {
      if (!/^[A-Z0-9]{2,30}$/.test(symbol)) throw new ApiError(400, 'Introduce un símbolo válido, por ejemplo BTCUSDT.')
      const data = await signed('/api/v3/account/commission', { symbol }, 60_000)
      return { fetchedAt: cache.get(`/api/v3/account/commission:${JSON.stringify({ symbol })}`).at, symbol: data.symbol, standardCommission: data.standardCommission, specialCommission: data.specialCommission, taxCommission: data.taxCommission, discount: data.discount }
    },
  }
}
