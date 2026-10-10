export type Account = { environment: string; fetchedAt: number; canTrade?: boolean; accountType: string; balances: { asset: string; free: string; locked: string }[] }
export type Rates = { maker: string; taker: string; buyer: string; seller: string }
export type Commission = { symbol: string; fetchedAt: number; standardCommission: Rates; specialCommission: Rates; taxCommission: Rates; discount: { enabledForAccount: boolean; enabledForSymbol: boolean; discountAsset: string; discount: string } }
export async function readApi<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(25_000) })
  let data: T & { error?: string }
  try { data = await response.json() as T & { error?: string } }
  catch { throw new Error('El backend no respondió. Ejecuta npm run dev:api en otra terminal.') }
  if (!response.ok) throw new Error(data.error ?? 'No se pudo consultar Binance.')
  return data
}
