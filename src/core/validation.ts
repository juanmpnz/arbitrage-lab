import type { Account, Commission } from './account'
import type { BookQuote, Market, Opportunity } from './arbitrage'

export type ReferencePrice = { price: string; lastPrice?: string; mins: number; fetchedAt: number }
export type SymbolFilter = { filterType: string; minQty?: string; maxQty?: string; stepSize?: string; minNotional?: string; maxNotional?: string; applyToMarket?: boolean; applyMinToMarket?: boolean; applyMaxToMarket?: boolean; avgPriceMins?: number }
export type ValidationContext = { account: Account; commissions: Map<string, Commission>; referencePrices: Map<string, ReferencePrice>; slippageBps: number; minNetBps: number; now: number }
export type ValidationResult = { opportunity?: Opportunity; reason?: string }

// Round down using the exchange's decimal step, without a float epsilon that
// could accidentally increase the submitted quantity. This remains an estimate.
export function floorStep(value: number, step: string): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const digits = step.includes('.') ? step.split('.')[1].length : 0
  if (digits > 16) return 0
  const scale = 10 ** digits
  const units = Math.round(Number(step) * scale)
  if (!Number.isSafeInteger(units) || units <= 0) return value
  return Math.floor(Math.floor(value * scale) / units) * units / scale
}

export function validateRoute(route: Opportunity, markets: Market[], books: Map<string, BookQuote>, context: ValidationContext): ValidationResult {
  const fail = (reason: string): ValidationResult => ({ reason })
  const { account, commissions, referencePrices, now } = context
  if (!Number.isFinite(route.input) || route.input <= 0 || !Number.isFinite(context.minNetBps) || context.minNetBps < 0) return fail('Importe o umbral inválido')
  if (account.environment !== 'live') return fail('Testnet: precios live incompatibles')
  if (!account.canTrade) return fail('Cuenta sin permiso de trading Spot')
  if (now - account.fetchedAt > 60_000) return fail('Saldo pendiente de actualizar')
  const balances = new Map(account.balances.map(b => [b.asset, Number(b.free)]))
  const free = balances.get(route.route[0]) ?? 0
  if (!Number.isFinite(free) || route.input > free) return fail('Saldo disponible insuficiente')
  if (!Number.isFinite(context.slippageBps) || context.slippageBps < 0 || context.slippageBps >= 10_000) return fail('Deslizamiento inválido')
  const bySymbol = new Map(markets.map(m => [m.symbol, m]))
  const fresh = (q: BookQuote | undefined) => q && now - q.receivedAt <= 2_000
  const toBNB = (asset: string, amount: number): number | null => {
    if (asset === 'BNB') return amount
    // Use the ask/bid conversion that estimates the BNB required to pay fees.
    for (const m of markets) {
      const q = books.get(m.symbol)
      if (!fresh(q)) continue
      if (m.baseAsset === 'BNB' && m.quoteAsset === asset) return amount / Number(q!.bidPrice)
      if (m.quoteAsset === 'BNB' && m.baseAsset === asset) return amount * Number(q!.askPrice)
    }
    return null
  }
  const legFees: number[] = []
  let value = route.input
  let reservedBNB = route.route[0] === 'BNB' ? route.input : 0
  for (let i = 0; i < 3; i++) {
    const symbol = route.symbols[i], market = bySymbol.get(symbol), quote = books.get(symbol)
    if (!market || market.status !== 'TRADING' || !market.isSpotTradingAllowed || !fresh(quote)) return fail(`${symbol}: mercado o cotización no disponible`)
    const fee = commissions.get(symbol)
    if (!fee || now - fee.fetchedAt > 60_000) return fail(`${symbol}: comisión pendiente`)
    if (!market.filters?.length) return fail(`${symbol}: reglas pendientes`)
    const buying = route.route[i] === market.quoteAsset
    const price = Number(buying ? quote!.askPrice : quote!.bidPrice)
    let qty = buying ? value / price : value
    const qtyFilters = market.filters.filter(f => f.filterType === 'LOT_SIZE' || f.filterType === 'MARKET_LOT_SIZE')
    if (!qtyFilters.some(f => f.filterType === 'LOT_SIZE')) return fail(`${symbol}: reglas de cantidad pendientes`)
    for (const f of qtyFilters) if (Number(f.stepSize) > 0) qty = floorStep(qty, f.stepSize!)
    for (const f of qtyFilters) {
      if (![f.minQty, f.maxQty, f.stepSize].every(n => n !== undefined && Number.isFinite(Number(n)) && Number(n) >= 0)) return fail(`${symbol}: reglas de cantidad inválidas`)
      if (qty < Number(f.minQty ?? 0) || (Number(f.maxQty) > 0 && qty > Number(f.maxQty))) return fail(`${symbol}: cantidad fuera de límites`)
      if (Number(f.stepSize) > 0 && Math.abs(qty - Math.round(qty / Number(f.stepSize)) * Number(f.stepSize)) > Number(f.stepSize) * 1e-7 + Number.EPSILON * qty * 4) return fail(`${symbol}: paso de cantidad incompatible`)
    }
    if (qty <= 0) return fail(`${symbol}: cantidad redondeada a cero`)
    if (qty > Number(buying ? quote!.askQty : quote!.bidQty)) return fail(`${symbol}: liquidez insuficiente en primer nivel`)
    for (const f of market.filters) {
      const minApplies = (f.filterType === 'MIN_NOTIONAL' && f.applyToMarket) || (f.filterType === 'NOTIONAL' && f.applyMinToMarket)
      const maxApplies = f.filterType === 'NOTIONAL' && f.applyMaxToMarket
      if (!minApplies && !maxApplies) continue
      if ((minApplies && !Number.isFinite(Number(f.minNotional))) || (maxApplies && !Number.isFinite(Number(f.maxNotional)))) return fail(`${symbol}: reglas de importe inválidas`)
      let reference = price
      if ((f.avgPriceMins ?? 0) > 0) {
        const avg = referencePrices.get(symbol)
        if (!avg || now - avg.fetchedAt > 30_000 || avg.mins !== f.avgPriceMins || !(Number(avg.price) > 0)) return fail(`${symbol}: precio promedio pendiente`)
        reference = Number(avg.price)
      }
      else {
        const last = referencePrices.get(symbol)
        if (!last || now - last.fetchedAt > 30_000 || !(Number(last.lastPrice) > 0)) return fail(`${symbol}: último precio pendiente`)
        reference = Number(last.lastPrice)
      }
      const notional = qty * reference
      if (minApplies && notional < Number(f.minNotional)) return fail(`${symbol}: importe inferior al mínimo`)
      if (maxApplies && notional > Number(f.maxNotional)) return fail(`${symbol}: importe superior al máximo`)
    }
    const side = buying ? 'buyer' : 'seller'
    const standard = Number(fee.standardCommission.taker) + Number(fee.standardCommission[side])
    const extra = Number(fee.specialCommission.taker) + Number(fee.specialCommission[side]) + Number(fee.taxCommission.taker) + Number(fee.taxCommission[side])
    if (![standard, extra].every(n => Number.isFinite(n) && n >= 0)) return fail(`${symbol}: tarifas inválidas`)
    const received = buying ? qty : qty * price
    const discount = Number(fee.discount.discount)
    const bnbFee = toBNB(route.route[i + 1], received * (standard * discount + extra))
    const useBNB = fee.discount.enabledForAccount && fee.discount.enabledForSymbol && fee.discount.discountAsset === 'BNB' && discount >= 0 && discount <= 1 && bnbFee !== null && Number.isFinite(bnbFee) && reservedBNB + bnbFee <= (balances.get('BNB') ?? 0)
    if (useBNB) reservedBNB += bnbFee!
    // Deduct the economic fee cost even when paid from a separate BNB balance.
    // This conservative estimate also discards rounding dust between legs.
    const cost = standard * (useBNB ? discount : 1) + extra
    legFees.push(cost * 10_000)
    if (cost >= 1) return fail(`${symbol}: costos inválidos`)
    value = received * (1 - cost) * (1 - context.slippageBps / 10_000)
  }
  const netBps = (value / route.input - 1) * 10_000
  if (netBps < context.minNetBps) return fail('Beneficio insuficiente después de costos y redondeos')
  return { opportunity: { ...route, grossOutput: route.output, output: value, netBps, legFeeBps: legFees as [number, number, number] } }
}
