export type Market = {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status: string
  isSpotTradingAllowed: boolean
}

export type BookQuote = {
  symbol: string
  bidPrice: string
  askPrice: string
  bidQty: string
  askQty: string
  receivedAt: number
}

type Edge = { symbol: string; from: string; to: string; rate: number; capacity: number; age: number }
export type Opportunity = {
  route: [string, string, string, string]
  symbols: [string, string, string]
  input: number
  output: number
  netBps: number
  oldestQuoteMs: number
}

export function buildEdges(markets: Market[], books: Map<string, BookQuote>, now: number): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>()
  const add = (edge: Edge) => graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge])
  for (const market of markets) {
    if (market.status !== 'TRADING' || !market.isSpotTradingAllowed) continue
    const quote = books.get(market.symbol)
    if (!quote) continue
    const bid = Number(quote.bidPrice), ask = Number(quote.askPrice)
    const bidQty = Number(quote.bidQty), askQty = Number(quote.askQty)
    if (![bid, ask, bidQty, askQty].every(Number.isFinite) || Math.min(bid, ask, bidQty, askQty) <= 0 || bid > ask) continue
    const age = Math.max(0, now - quote.receivedAt)
    add({ symbol: market.symbol, from: market.baseAsset, to: market.quoteAsset, rate: bid, capacity: bidQty, age })
    add({ symbol: market.symbol, from: market.quoteAsset, to: market.baseAsset, rate: 1 / ask, capacity: askQty * ask, age })
  }
  return graph
}

export function findOpportunities(
  markets: Market[], books: Map<string, BookQuote>, options: { startAsset: string; amount: number; feeBps: number; slippageBps: number; minNetBps: number; maxAgeMs: number }, now = Date.now(),
): Opportunity[] {
  const { startAsset, amount, feeBps, slippageBps, minNetBps, maxAgeMs } = options
  if (![amount, feeBps, slippageBps, minNetBps, maxAgeMs].every(Number.isFinite) || amount <= 0) return []
  const graph = buildEdges(markets, books, now)
  const factor = (1 - feeBps / 10_000) * (1 - slippageBps / 10_000)
  if (factor <= 0) return []
  const found: Opportunity[] = []
  for (const first of graph.get(startAsset) ?? []) {
    for (const second of graph.get(first.to) ?? []) {
      if (second.to === startAsset || second.to === first.to || first.symbol === second.symbol) continue
      for (const third of graph.get(second.to) ?? []) {
        if (third.to !== startAsset || new Set([first.symbol, second.symbol, third.symbol]).size !== 3) continue
        let value = amount
        for (const leg of [first, second, third]) {
          if (leg.age > maxAgeMs || value > leg.capacity) { value = 0; break }
          value *= leg.rate * factor
        }
        if (!value) continue
        const netBps = (value / amount - 1) * 10_000
        if (netBps < minNetBps) continue
        found.push({ route: [startAsset, first.to, second.to, startAsset], symbols: [first.symbol, second.symbol, third.symbol], input: amount, output: value, netBps, oldestQuoteMs: Math.max(first.age, second.age, third.age) })
      }
    }
  }
  return found.sort((a, b) => b.netBps - a.netBps)
}
