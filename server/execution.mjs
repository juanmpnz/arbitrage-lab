import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ApiError } from './binance.mjs'
const reject = message => { throw new ApiError(409, message) }
const decimal = value => value.toFixed(16).replace(/0+$/, '').replace(/\.$/, '')
function round(value, step, up = false) {
  const digits = step.includes('.') ? step.split('.')[1].length : 0
  const scale = 10 ** digits, units = Math.round(Number(step) * scale)
  if (!Number.isSafeInteger(units) || units <= 0 || !Number.isSafeInteger(Math.floor(value * scale))) reject('Paso decimal no soportado.')
  return (up ? Math.ceil(value * scale / units) : Math.floor(value * scale / units)) * units / scale
}
export function planLeg(market, quote, from, amount, fee) {
  if (market.status !== 'TRADING' || !market.isSpotTradingAllowed || !market.orderTypes?.includes('LIMIT')) reject('Mercado sin órdenes LIMIT Spot.')
  const buy = from === market.quoteAsset
  if (!buy && from !== market.baseAsset) reject('Ruta desconectada.')
  const priceRule = market.filters?.find(f => f.filterType === 'PRICE_FILTER'), lot = market.filters?.find(f => f.filterType === 'LOT_SIZE')
  if (!priceRule || !lot || !(Number(priceRule.tickSize) > 0) || !(Number(lot.stepSize) > 0)) reject('Faltan reglas de precio/cantidad.')
  const raw = Number(buy ? quote.askPrice : quote.bidPrice)
  if (!(raw > 0)) reject('Precio inválido.')
  const price = round(raw * (buy ? 1.0005 : .9995), priceRule.tickSize, buy)
  const quantity = round(buy ? amount / price : amount, lot.stepSize)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity < Number(lot.minQty) || quantity > Number(lot.maxQty) || price < Number(priceRule.minPrice) || (Number(priceRule.maxPrice) > 0 && price > Number(priceRule.maxPrice))) reject('Precio o cantidad fuera de límites.')
  if (quantity > Number(buy ? quote.askQty : quote.bidQty)) reject('Liquidez insuficiente en primer nivel.')
  const notional = price * quantity
  for (const f of market.filters) {
    if (['MIN_NOTIONAL', 'NOTIONAL'].includes(f.filterType) && (!(Number(f.minNotional) >= 0) || notional < Number(f.minNotional))) reject(`${market.symbol}: importe inferior al mínimo.`)
    if (f.filterType === 'NOTIONAL' && Number(f.maxNotional) > 0 && notional > Number(f.maxNotional)) reject('Importe superior al máximo.')
  }
  const side = buy ? 'buyer' : 'seller'
  const feeRate = ['standardCommission', 'specialCommission', 'taxCommission'].reduce((sum, key) => sum + Number(fee[key]?.taker) + Number(fee[key]?.[side]), 0)
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > .005) reject('Tarifas no verificadas o superiores al límite del ejecutor.')
  return { symbol: market.symbol, side: buy ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: 'FOK', price: decimal(price), quantity: decimal(quantity), newOrderRespType: 'FULL', to: buy ? market.baseAsset : market.quoteAsset, projected: (buy ? quantity : notional) * (1 - feeRate) }
}
export function createExecutor({ reader, file, enabled = false, now = Date.now }) {
  const environment = reader.environment
  let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { reserved: 0, runs: [] }
  if (!Array.isArray(state.runs) || !Number.isFinite(state.reserved) || state.reserved < 0 || state.reserved > 7 || (state.environment && state.environment !== environment)) throw new Error('Diario de ejecución incompatible con el entorno.')
  state.environment = environment
  state.runs.forEach(run => { if (['RUNNING', 'PREPARING'].includes(run.status)) { run.status = 'REVIEW'; run.message = 'Servidor interrumpido: conciliar antes de operar.' } })
  let busy = false, stopped = false
  const previews = new Map()
  const save = () => { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${file}.tmp`, file) } catch (error) { stopped = true; throw error } }
  const allowed = () => {
    if (!enabled) reject('Ejecutor desactivado. Configura BINANCE_TRADING_ENABLED=true y reinicia.')
    if (busy || stopped || existsSync(`${file}.lock`) || state.runs.some(run => run.status === 'REVIEW')) reject('Ejecutor ocupado, detenido o con órdenes pendientes de revisión.')
  }
  const asset = environment === 'live' ? 'USDS' : 'USDT'
  async function prepare(input) {
    if (!input || !Array.isArray(input.symbols) || input.symbols.length !== 3 || new Set(input.symbols).size !== 3 || !input.symbols.every(s => typeof s === 'string' && /^[A-Z0-9]{2,30}$/.test(s)) || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 6.6) reject('Se requieren tres símbolos distintos y un importe de hasta 6,6; se reserva margen para costos dentro del límite total de 7.')
    if (state.reserved + input.amount * 1.05 > 7) reject('Presupuesto acumulado de 7 agotado; no se reinicia al recargar.')
    const [account, info, fees] = await Promise.all([reader.account(true), reader.markets(), Promise.all(input.symbols.map(s => reader.commission(s)))])
    if (!account.canTrade || account.environment !== environment || info.environment !== environment) reject('Cuenta o entorno no habilitado para trading.')
    if (Number(account.balances.find(b => b.asset === asset)?.free ?? 0) < input.amount * 1.05) reject('Saldo inicial insuficiente, incluida la reserva de costos.')
    const markets = input.symbols.map(symbol => { const market = info.symbols.find(m => m.symbol === symbol); if (!market) reject('Símbolo no disponible.'); return market })
    const books = await Promise.all(input.symbols.map(s => reader.book(s)))
    let value = input.amount, from = asset
    const legs = []
    for (let i = 0; i < 3; i++) { const leg = planLeg(markets[i], books[i], from, value, fees[i]); legs.push(leg); from = leg.to; value = leg.projected }
    if (from !== asset || !(value > input.amount * 1.0001) || value > input.amount * 1.1) reject('El ciclo no supera el umbral neto de 1 pb con precios limitados y costos conservadores.')
    return { asset, markets, fees, legs, account, output: value, input: input.amount, symbols: input.symbols }
  }
  return {
    status() { return { enabled, environment, asset, busy, stopped, reserved: state.reserved, limit: 7, runs: state.runs.slice().reverse() } },
    stop() { stopped = true; return this.status() },
    async reconcile(id) {
      if (busy) reject('Espera a que termine el envío en curso.')
      const run = state.runs.find(item => item.id === id)
      if (!run) reject('Ejecución no encontrada.')
      for (const leg of run.legs) {
        try {
          leg.reconciled = await reader.queryOrder(leg.symbol, leg.newClientOrderId)
          if (leg.reconciled.orderId !== undefined) leg.trades = await reader.orderTrades(leg.symbol, leg.reconciled.orderId)
        } catch (error) { leg.reconcileError = error.message }
      }
      run.balancesAfter = (await reader.account(true)).balances
      run.reconciledAt = now(); save()
      return run // Reconciliation never resumes a cycle or grants more budget.
    },
    async preview(input) {
      allowed()
      const plan = await prepare(input)
      const { to, projected, ...firstOrder } = plan.legs[0]
      await reader.testOrder(firstOrder)
      const token = randomUUID(); const at = now()
      if (previews.size >= 64) previews.delete(previews.keys().next().value)
      previews.set(token, { at, input: { symbols: input.symbols, amount: input.amount } })
      for (const [key, value] of previews) if (at - value.at > 15_000) previews.delete(key)
      return { token, expiresAt: at + 15_000, asset, environment, input: plan.input, output: plan.output, legs: plan.legs, reserved: plan.input * 1.05 }
    },
    async execute(token) {
      allowed()
      const preview = previews.get(token); previews.delete(token)
      if (!preview || now() - preview.at > 15_000) reject('Previsualización caducada o ya utilizada.')
      mkdirSync(dirname(file), { recursive: true })
      try { mkdirSync(`${file}.lock`) } catch { reject('Otro ejecutor tiene el diario bloqueado; revisar antes de continuar.') }
      try {
        if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8'))
        if (!Number.isFinite(state.reserved) || state.reserved < 0 || state.reserved > 7 || state.environment !== environment || state.runs.some(run => ['RUNNING', 'PREPARING', 'REVIEW'].includes(run.status))) reject('Diario pendiente de revisión o incompatible.')
      } catch (error) { rmSync(`${file}.lock`, { recursive: true, force: true }); throw error }
      busy = true
      const run = { id: randomUUID(), status: 'PREPARING', startedAt: now(), asset, input: preview.input.amount, legs: [], holdings: {}, message: '' }
      let sent = false
      try {
        const plan = await prepare(preview.input)
        if (stopped) reject('Ejecución detenida.')
        run.budgetReserved = run.input * 1.05; state.reserved += run.budgetReserved; state.runs.push(run); run.balancesBefore = plan.account.balances; run.status = 'RUNNING'; save()
        let amount = run.input, from = asset
        run.holdings[asset] = amount
        for (let i = 0; i < 3; i++) {
          if (stopped) reject('Detenido antes del siguiente tramo.')
          const remainingBooks = await Promise.all(plan.symbols.slice(i).map(s => reader.book(s)))
          let estimate = amount, source = from
          const remainingPlans = []
          for (let j = i; j < 3; j++) { const leg = planLeg(plan.markets[j], remainingBooks[j - i], source, estimate, plan.fees[j]); remainingPlans.push(leg); source = leg.to; estimate = leg.projected }
          if (!(estimate > run.input * 1.0001)) reject('La rentabilidad se perdió antes del siguiente tramo; revisar saldos residuales.')
          const { to, projected, ...order } = remainingPlans[0]
          order.newClientOrderId = `al-${run.id.slice(0, 24)}-${i}`
          await reader.testOrder(order)
          if (stopped || remainingBooks.some(q => now() - q.receivedAt > 1500)) reject('Detenido o precios obsoletos antes de enviar.')
          const entry = { ...order, status: 'SUBMITTING' }; run.legs.push(entry); save()
          sent = true
          let result
          try { result = await reader.placeOrder(order) }
          catch (error) {
            entry.status = 'UNKNOWN'; entry.message = error.message; save()
            try { entry.result = await reader.queryOrder(order.symbol, order.newClientOrderId); entry.status = entry.result.status } catch { /* Persist unknown, never resubmit. */ }
            reject('Envío rechazado o incierto: no se reintenta. Revisar la orden y los activos en Binance.')
          }
          entry.result = result; entry.status = result.status; save()
          if (result.status !== 'FILLED' || !Array.isArray(result.fills) || !result.fills.length || Number(result.executedQty) !== Number(order.quantity)) reject('Orden no completamente ejecutada o sin detalle de comisiones. Revisión necesaria.')
          const executed = Number(result.executedQty), quote = Number(result.cummulativeQuoteQty)
          if (!(executed > 0) || !(quote > 0) || Math.abs(result.fills.reduce((sum, fill) => sum + Number(fill.qty), 0) - executed) > executed * 1e-8) reject('Detalle de ejecución inconsistente.')
          let received = order.side === 'BUY' ? executed : quote
          const spent = order.side === 'BUY' ? quote : executed
          if (spent > amount * (1 + 1e-8)) reject('Gasto de orden fuera del saldo asignado.')
          for (const fill of result.fills) {
            if (!Number.isFinite(Number(fill.commission)) || Number(fill.commission) < 0) reject('Comisiones de ejecución inválidas.')
            if (fill.commissionAsset === to) received -= Number(fill.commission)
            else if (fill.commissionAsset === from) run.holdings[from] = (run.holdings[from] ?? 0) - Number(fill.commission)
          }
          run.holdings[from] = (run.holdings[from] ?? 0) - spent
          run.holdings[to] = (run.holdings[to] ?? 0) + received
          amount = received; from = to; save()
        }
        run.status = 'COMPLETED'; run.message = 'Tres órdenes ejecutadas. Las comisiones y activos residuales figuran en el detalle.'
      } catch (error) {
        if (!sent && run.budgetReserved) { state.reserved -= run.budgetReserved; run.budgetReleased = true }
        run.status = sent ? 'REVIEW' : 'STOPPED'; run.message = error instanceof Error ? error.message : 'Ejecución detenida.'
        if (!state.runs.includes(run)) state.runs.push(run)
      } finally {
        run.finishedAt = now()
        try { run.balancesAfter = (await reader.account(true)).balances } catch { run.balanceError = 'No se pudo actualizar el saldo; consultar Binance.' }
        try { save() } finally { busy = false; rmSync(`${file}.lock`, { recursive: true, force: true }) }
      }
      return run
    },
  }
}
