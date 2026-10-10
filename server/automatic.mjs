import { randomUUID } from 'node:crypto'
const bridges = new Set(['USDS', 'USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'EUR'])
export function buildCycles(markets, startAsset) {
  const graph = new Map()
  for (const market of markets) {
    for (const [from, to, buy] of [[market.quoteAsset, market.baseAsset, true], [market.baseAsset, market.quoteAsset, false]]) {
      const edge = { symbol: market.symbol, from, to, buy }
      graph.set(from, [...(graph.get(from) ?? []), edge])
    }
  }
  const cycles = []
  for (const first of graph.get(startAsset) ?? []) for (const second of graph.get(first.to) ?? []) {
    if (second.to === startAsset) continue
    for (const third of graph.get(second.to) ?? []) if (third.to === startAsset && new Set([first.symbol, second.symbol, third.symbol]).size === 3) cycles.push([first, second, third])
  }
  return cycles
}
export function grossCandidates(cycles, books, amount, now) {
  const result = []
  for (const cycle of cycles) {
    let value = amount, oldestQuoteMs = 0
    for (const leg of cycle) {
      const quote = books.get(leg.symbol)
      if (!quote || now - quote.receivedAt > 2000) { value = 0; break }
      oldestQuoteMs = Math.max(oldestQuoteMs, now - quote.receivedAt)
      const price = Number(leg.buy ? quote.askPrice : quote.bidPrice)
      const capacity = Number(leg.buy ? quote.askQty : quote.bidQty) * (leg.buy ? price : 1)
      if (!(price > 0) || value > capacity) { value = 0; break }
      value = leg.buy ? value / price : value * price
    }
    if (value > amount) result.push({ route: [cycle[0].from, cycle[0].to, cycle[1].to, cycle[2].to], symbols: cycle.map(leg => leg.symbol), input: amount, output: value, netBps: (value / amount - 1) * 10000, oldestQuoteMs })
  }
  return result.sort((a, b) => b.netBps - a.netBps)
}
export function createAutomaticWorker({ reader, executor, history, enabled = false, amount = 6.6, now = Date.now, WebSocketImpl = globalThis.WebSocket }) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 6.6) throw new Error('AUTO_TRADE_AMOUNT debe estar entre 0 y 6.6.')
  const asset = reader.environment === 'live' ? 'USDS' : 'USDT'
  const state = { enabled, running: false, connection: 'stopped', subscribed: 0, cycles: 0, lastQuoteAt: null, lastEvaluationAt: null, lastExecutionAt: null, lastReason: '', grossCandidates: 0, amount, asset }
  const books = new Map(), cooldowns = new Map(), sessionId = `server-${randomUUID()}`
  let cycles = [], socket = null, timer = null, retry = null, rotate = null, handshake = null, batches = [], evaluating = false, generation = 0, recorded = false, openedAt = 0
  const closeSocket = () => { const old = socket; socket = null; old?.close(); batches.forEach(clearTimeout); batches = []; clearTimeout(rotate); clearTimeout(handshake); books.clear(); state.lastQuoteAt = null; openedAt = 0 }
  const persist = opportunities => {
    if (!opportunities.length && !recorded) return
    recorded = opportunities.length > 0
    history?.observe({ sessionId, snapshots: [{ capturedAt: now(), config: { startAsset: asset, amount, feeMode: 'account', slippageBps: 5, minNetBps: 1 }, opportunities }] })
  }
  const halt = message => { state.running = false; state.connection = 'stopped'; state.lastReason = message; generation++; clearInterval(timer); clearTimeout(retry); closeSocket() }
  async function evaluate() {
    if (!state.running || evaluating) return
    const status = executor.status()
    if (status.stopped || status.runs.some(run => run.status === 'REVIEW')) { halt('Ejecución detenida o pendiente de revisión.'); return }
    if (status.reserved + amount * 1.05 > status.limit) { halt('Presupuesto acumulado agotado. No se reinvierte ni aumenta automáticamente.'); return }
    if (status.busy) return
    if (openedAt && now() - (state.lastQuoteAt ?? openedAt) > 30_000 && socket) { state.lastReason = 'Stream sin cotizaciones: reconectando.'; socket.close(); return }
    const candidates = grossCandidates(cycles, books, amount, now())
    state.lastEvaluationAt = now(); state.grossCandidates = candidates.length
    if (!candidates.length) {
      state.lastReason = cycles.length ? 'Esperando un margen bruto positivo con cotizaciones frescas.' : `No hay ciclos disponibles para ${asset} en los mercados suscritos.`
      try { persist([]) } catch (error) { halt(`No se pudo registrar el historial: ${error.message}`) }
      return
    }
    evaluating = true
    const current = generation
    try {
      const candidate = candidates.slice(0, 20).find(item => (cooldowns.get(item.symbols.join(',')) ?? 0) <= now())
      if (!candidate) return
      const key = candidate.symbols.join(','); cooldowns.set(key, now() + 30_000)
      const preview = await executor.preview({ symbols: candidate.symbols, amount })
      if (!state.running || current !== generation) return
      if (preview.quoteAgeMs !== undefined && preview.quoteAgeMs > 2000) return
      // Only the executor's server-validated net result is logged as a signal.
      persist([{ ...candidate, output: preview.output, legFeeBps: preview.legFeeBps, oldestQuoteMs: preview.quoteAgeMs ?? 0, netBps: (preview.output / amount - 1) * 10000 }])
      state.lastReason = 'Ruta neta validada: enviando el ciclo automáticamente.'
      const run = await executor.execute(preview.token)
      state.lastExecutionAt = now()
      if (run.status !== 'COMPLETED') { halt(`${run.status}: ${run.message}`); return }
      state.lastReason = 'Ciclo completado; comprobando presupuesto restante.'
      if (executor.status().reserved + amount * 1.05 > status.limit) halt('Prueba completada; presupuesto insuficiente para otro ciclo. Consulta órdenes y saldo real.')
    } catch (error) { state.lastReason = error instanceof Error ? error.message : 'No se pudo verificar la ruta.'; if ([-2015, -2014, -1022, -1003].includes(error.binanceCode)) halt(state.lastReason) }
    finally { evaluating = false }
  }
  async function connect() {
    if (!state.running) return
    const current = generation
    state.connection = 'connecting'
    try {
      const info = await reader.markets()
      if (!state.running || current !== generation) return
      const markets = info.symbols.filter(m => m.status === 'TRADING' && m.isSpotTradingAllowed && m.orderTypes?.includes('LIMIT') && (m.baseAsset === asset || m.quoteAsset === asset || bridges.has(m.baseAsset) || bridges.has(m.quoteAsset)))
      markets.sort((a, b) => Number(b.baseAsset === asset || b.quoteAsset === asset) - Number(a.baseAsset === asset || a.quoteAsset === asset))
      const selected = markets.slice(0, 900)
      if (!selected.length) throw new Error('No hay mercados Spot disponibles.')
      cycles = buildCycles(selected, asset); state.cycles = cycles.length; state.subscribed = selected.length
      socket = new WebSocketImpl(reader.environment === 'live' ? 'wss://stream.binance.com:443/ws' : 'wss://stream.testnet.binance.vision/ws')
      handshake = setTimeout(() => { if (socket?.readyState === 0) socket.close() }, 10000)
      const connection = socket, allowed = new Set(selected.map(m => m.symbol))
      connection.onopen = () => {
        if (!state.running || connection !== socket) return
        clearTimeout(handshake); openedAt = now(); state.lastQuoteAt = null; state.connection = 'loading'
        for (let i = 0; i < selected.length; i += 100) batches.push(setTimeout(() => {
          if (state.running && connection === socket && connection.readyState === 1) connection.send(JSON.stringify({ method: 'SUBSCRIBE', params: selected.slice(i, i + 100).map(m => `${m.symbol.toLowerCase()}@bookTicker`), id: i + 1 }))
        }, Math.floor(i / 100) * 300))
        rotate = setTimeout(() => connection.close(), 23 * 60 * 60 * 1000)
      }
      connection.onmessage = event => {
        if (!state.running || connection !== socket) return
        try {
          const data = JSON.parse(String(event.data))
          if (data.code !== undefined) { state.lastReason = 'Binance rechazó una suscripción.'; connection.close(); return }
          if (!allowed.has(data.s)) return
          if (![data.b, data.a, data.B, data.A].every(v => Number.isFinite(Number(v)) && Number(v) > 0) || Number(data.b) > Number(data.a)) return
          books.set(data.s, { bidPrice: data.b, askPrice: data.a, bidQty: data.B, askQty: data.A, receivedAt: now() })
          state.lastQuoteAt = now(); state.connection = 'live'
        } catch { state.lastReason = 'Mensaje de mercado inválido.' }
      }
      connection.onerror = () => { state.lastReason = 'Error de WebSocket del backend.'; connection.close() }
      connection.onclose = () => {
        if (connection !== socket) return
        closeSocket()
        if (state.running) { state.connection = 'reconnecting'; retry = setTimeout(() => void connect(), 5000) }
      }
    } catch (error) {
      state.lastReason = error instanceof Error ? error.message : 'No se pudo cargar el mercado.'
      state.connection = 'reconnecting'
      if (state.running && current === generation) retry = setTimeout(() => void connect(), 10000)
    }
  }
  return {
    status() { return { ...state } },
    start() {
      if (!enabled || state.running) return
      if (reader.configured === false) { state.lastReason = 'Completa las claves privadas del backend antes de activar el automático.'; return }
      if (!executor.status().enabled) { state.lastReason = 'Activa BINANCE_TRADING_ENABLED para ejecutar automáticamente.'; return }
      if (typeof WebSocketImpl !== 'function') { state.lastReason = 'Se requiere Node 22.12+ con WebSocket.'; return }
      state.running = true; generation++; timer = setInterval(() => void evaluate(), 1000); void connect()
    },
    stop() { halt('Modo automático detenido.'); executor.stop(); return this.status() },
    evaluate,
  }
}
