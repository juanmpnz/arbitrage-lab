import type { BookQuote, Market } from './arbitrage'

const REST = 'https://data-api.binance.vision/api/v3'
const SOCKET = 'wss://stream.binance.com:9443/ws'
const MAX_STREAMS = 900
const BRIDGE_ASSETS = new Set(['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'FDUSD'])

type Ticker24h = { symbol: string; lastPrice: string; quoteVolume: string }
type ExchangeInfo = { symbols: Market[] }
type Handlers = {
  onStatus: (status: 'connecting' | 'loading' | 'live' | 'reconnecting' | 'error') => void
  onQuote: (quote: BookQuote) => void
  onStats: (stats: { subscribed: number; messages: number; lastMessageAt: number | null }) => void
  onError: (message: string) => void
}

export async function loadMarkets(): Promise<Market[]> {
  const [exchangeResponse, tickerResponse] = await Promise.all([
    fetch(`${REST}/exchangeInfo`, { cache: 'no-store' }),
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
  const eligible = exchange.symbols.filter((market) => market.status === 'TRADING' && market.isSpotTradingAllowed && (BRIDGE_ASSETS.has(market.baseAsset) || BRIDGE_ASSETS.has(market.quoteAsset)))
  eligible.sort((a, b) => (volume.get(b.symbol) ?? 0) - (volume.get(a.symbol) ?? 0))
  return eligible.slice(0, MAX_STREAMS)
}

export function connectMarketStream(markets: Market[], handlers: Handlers): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let retryTimer = 0
  let rotateTimer = 0
  let failures = 0

  const connect = () => {
    if (stopped) return
    handlers.onStatus(failures ? 'reconnecting' : 'connecting')
    socket = new WebSocket(SOCKET)
    socket.onopen = () => {
      if (stopped || !socket) return
      failures = 0
      handlers.onStatus('loading')
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: markets.map((market) => `${market.symbol.toLowerCase()}@bookTicker`), id: Date.now() }))
      handlers.onStats({ subscribed: markets.length, messages: 0, lastMessageAt: null })
      // Binance disconnects a stream connection after 24h; rotate before the limit.
      rotateTimer = window.setTimeout(() => socket?.close(1000, 'Planned connection rotation'), 23 * 60 * 60 * 1000)
    }
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>
        if (data.result === null || data.id) return
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
      window.clearTimeout(rotateTimer)
      if (stopped) return
      failures += 1
      handlers.onStatus('reconnecting')
      retryTimer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)))
    }
  }
  connect()
  return () => {
    stopped = true
    window.clearTimeout(retryTimer)
    window.clearTimeout(rotateTimer)
    socket?.close(1000, 'Client stopped')
  }
}

