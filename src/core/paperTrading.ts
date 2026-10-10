import type { Opportunity } from './arbitrage'

export const PAPER_ACCOUNT_STORAGE_KEY = 'arbitrage-lab.paper-account.v1'
export const DEFAULT_PAPER_BALANCE = 1_000
export const PAPER_TRADE_COOLDOWN_MS = 60_000
const MAX_PAPER_TRADES = 100

export type PaperTrade = {
  id: string
  executedAt: number
  route: Opportunity['route']
  symbols: Opportunity['symbols']
  input: number
  output: number
  profit: number
  netBps: number
  oldestQuoteMs: number
}

export type PaperAccount = {
  initialBalance: number
  balance: number
  totalTrades: number
  trades: PaperTrade[]
  lastTradeAtByRoute: Record<string, number>
}

export type PaperTradeResult =
  | { accepted: true; account: PaperAccount; trade: PaperTrade }
  | { accepted: false; account: PaperAccount; reason: string }

export function createPaperAccount(initialBalance = DEFAULT_PAPER_BALANCE): PaperAccount {
  const safeBalance = Number.isFinite(initialBalance) && initialBalance >= 0 ? initialBalance : DEFAULT_PAPER_BALANCE
  return { initialBalance: safeBalance, balance: safeBalance, totalTrades: 0, trades: [], lastTradeAtByRoute: {} }
}

export function parsePaperAccount(raw: string | null): PaperAccount {
  if (!raw) return createPaperAccount()
  try {
    const value = JSON.parse(raw) as Partial<PaperAccount>
    if (!Number.isFinite(value.initialBalance) || !Number.isFinite(value.balance) || !Array.isArray(value.trades)) return createPaperAccount()
    return {
      initialBalance: Math.max(0, value.initialBalance as number),
      balance: Math.max(0, value.balance as number),
      totalTrades: Number.isFinite(value.totalTrades) ? Math.max(0, value.totalTrades as number) : value.trades.length,
      trades: value.trades.slice(0, MAX_PAPER_TRADES) as PaperTrade[],
      lastTradeAtByRoute: value.lastTradeAtByRoute && typeof value.lastTradeAtByRoute === 'object' ? value.lastTradeAtByRoute : {},
    }
  } catch {
    return createPaperAccount()
  }
}

export function recordPaperTrade(
  account: PaperAccount,
  opportunity: Opportunity,
  now = Date.now(),
  cooldownMs = PAPER_TRADE_COOLDOWN_MS,
  maxQuoteAgeMs = 2_000,
): PaperTradeResult {
  const routeKey = opportunity.symbols.join('>')
  const lastTradeAt = account.lastTradeAtByRoute[routeKey]
  if (lastTradeAt !== undefined && now - lastTradeAt < cooldownMs) return { accepted: false, account, reason: 'Esta ruta está en período de espera.' }
  if (!Number.isFinite(opportunity.oldestQuoteMs) || opportunity.oldestQuoteMs > maxQuoteAgeMs) return { accepted: false, account, reason: 'Las cotizaciones ya están obsoletas.' }
  if (!Number.isFinite(opportunity.input) || !Number.isFinite(opportunity.output) || opportunity.input <= 0 || opportunity.output <= opportunity.input) {
    return { accepted: false, account, reason: 'La ruta no tiene beneficio neto positivo.' }
  }
  if (opportunity.input > account.balance) return { accepted: false, account, reason: 'Saldo virtual insuficiente para esta ruta.' }

  const trade: PaperTrade = {
    id: `${now}-${routeKey}`,
    executedAt: now,
    route: opportunity.route,
    symbols: opportunity.symbols,
    input: opportunity.input,
    output: opportunity.output,
    profit: opportunity.output - opportunity.input,
    netBps: opportunity.netBps,
    oldestQuoteMs: opportunity.oldestQuoteMs,
  }
  const nextAccount: PaperAccount = {
    ...account,
    balance: account.balance + trade.profit,
    totalTrades: account.totalTrades + 1,
    trades: [trade, ...account.trades].slice(0, MAX_PAPER_TRADES),
    lastTradeAtByRoute: { ...account.lastTradeAtByRoute, [routeKey]: now },
  }
  return { accepted: true, account: nextAccount, trade }
}
