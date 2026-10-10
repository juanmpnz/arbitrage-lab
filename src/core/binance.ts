import type { BookQuote, Market } from './arbitrage'

const REST = 'https://data-api.binance.vision/api/v3'
// Binance publishes the Spot stream on both 9443 and 443. Prefer 443 because
// some networks and browser environments block non-standard TLS ports.
const SOCKET = 'wss://stream.binance.com:443/ws'
const MAX_STREAMS = 900
const SUBSCRIPTION_BATCH_SIZE = 100
const SUBSCRIPTION_INTERVAL_MS = 300
const BRIDGE_ASSETS = new Set(['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'FDUSD', 'USDS', 'EUR'])

type Ticker24h = { symbol: string; lastPrice: string; quoteVolume: string }
type ExchangeInfo = { symbols: Market[] }
type Handlers = {
  onStatus: (status: 'connecting' | 'loading' | 'live' | 'reconnecting' | 'error') => void
  onQuote: (quote: BookQuote) => void
  onStats: (stats: { subscribed: number; messages: number; lastMessageAt: number | null }) => void
  onError: (message: string) => void
}

export async function loadMarkets(startAsset = 'USDT', fromBackend = false): Promise<Market[]> {
  const [exchangeResponse, tickerResponse] = await Promise.all([
    fetch(fromBackend ? '/api/markets' : `${REST}/exchangeInfo`, { cache: 'no-store' }),
    fetch(`${REST}/ticker/24hr`, { cache: 'no-store' }),
  ])
  if (!exchangeResponse.ok || !tickerResponse.ok) throw new Error('Binance no respondió al cargar los mercados.')
  const exchange = await exchangeResponse.json() as ExchangeInfo
  const tickers = await tickerResponse.json() as Ticker24h[]
  const marketsBySymbol = new Map(exchange.symbols.map((market) => [market.symbol, market] as const))
  const usdPrice = new Map<string, number>([['USDT', 1], ['USDC', 1], ['FDUSD', 1]])
  for (const ticker of tickers) {
    const market = marketsBySymbol.get(ticker.symbol)
    if (market && usdPrice.has(market.quoteAsset)) usdPrice.set(market.baseAsset, Number(ticker.lastPrice))
  }
  const volume = new Map(tickers.map((ticker) => {
    const market = marketsBySymbol.get(ticker.symbol)
    return [ticker.symbol, Number(ticker.quoteVolume) * (usdPrice.get(market?.quoteAsset ?? '') ?? 0)] as const
  }))
  const eligible = exchange.symbols.filter((market) => market.status === 'TRADING' && market.isSpotTradingAllowed && (market.baseAsset === startAsset || market.quoteAsset === startAsset || BRIDGE_ASSETS.has(market.baseAsset) || BRIDGE_ASSETS.has(market.quoteAsset)))
  eligible.sort((a, b) => Number(b.baseAsset === startAsset || b.quoteAsset === startAsset) - Number(a.baseAsset === startAsset || a.quoteAsset === startAsset) || (volume.get(b.symbol) ?? 0) - (volume.get(a.symbol) ?? 0))
  return eligible.slice(0, MAX_STREAMS)
}

export function connectMarketStream(markets: Market[], handlers: Handlers): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let retryTimer = 0
  let rotateTimer = 0
  let connectTimer = 0
  let subscriptionTimers: number[] = []
  let failures = 0

  const connect = () => {
    if (stopped) return
    handlers.onStatus(failures ? 'reconnecting' : 'connecting')
    socket = new WebSocket(SOCKET)
    connectTimer = window.setTimeout(() => {
      if (socket?.readyState === WebSocket.CONNECTING) {
        handlers.onError('Binance no completó la conexión WebSocket en 10 segundos.')
        socket.close()
      }
    }, 10_000)
    socket.onopen = () => {
      if (stopped || !socket) return
      window.clearTimeout(connectTimer)
      failures = 0
      handlers.onStatus('loading')
      const streams = markets.map((market) => `${market.symbol.toLowerCase()}@bookTicker`)
      const batches = Array.from({ length: Math.ceil(streams.length / SUBSCRIPTION_BATCH_SIZE) }, (_, index) =>
        streams.slice(index * SUBSCRIPTION_BATCH_SIZE, (index + 1) * SUBSCRIPTION_BATCH_SIZE))
      subscriptionTimers = batches.map((params, index) => window.setTimeout(() => {
        if (socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: Date.now() + index }))
      }, index * SUBSCRIPTION_INTERVAL_MS))
      handlers.onStats({ subscribed: markets.length, messages: 0, lastMessageAt: null })
      // Binance disconnects a stream connection after 24h; rotate before the limit.
      rotateTimer = window.setTimeout(() => socket?.close(1000, 'Planned connection rotation'), 23 * 60 * 60 * 1000)
    }
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>
        if (data.code !== undefined || data.msg !== undefined) {
          handlers.onError(`Binance rechazó la suscripción (${String(data.code ?? 'sin código')}): ${String(data.msg ?? 'respuesta inesperada')}`)
          return
        }
        // A successful SUBSCRIBE acknowledgement has an id and a null result.
        if (data.id !== undefined && data.result === null) return
        const symbol = String(data.s ?? '')
        if (!symbol) return
        const quote: BookQuote = {
          symbol, bidPrice: String(data.b), askPrice: String(data.a),
          bidQty: String(data.B), askQty: String(data.A), receivedAt: Date.now(),
        }
        handlers.onQuote(quote)
        handlers.onStatus('live')
      } catch {
        handlers.onError('Llegó un mensaje que no se pudo interpretar.')
      }
    }
    socket.onerror = () => handlers.onError('La conexión WebSocket tuvo un error.')
    socket.onclose = () => {
      window.clearTimeout(connectTimer)
      window.clearTimeout(rotateTimer)
      subscriptionTimers.forEach(window.clearTimeout)
      subscriptionTimers = []
      if (stopped) return
      failures += 1
      handlers.onError('Binance cerró el stream. Se intentará reconectar automáticamente.')
      handlers.onStatus('reconnecting')
      retryTimer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)))
    }
  }
  connect()
  return () => {
    stopped = true
    window.clearTimeout(connectTimer)
    window.clearTimeout(retryTimer)
    window.clearTimeout(rotateTimer)
    subscriptionTimers.forEach(window.clearTimeout)
    socket?.close(1000, 'Client stopped')
  }
}

