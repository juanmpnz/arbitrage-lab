import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
const RouteScene = lazy(() => import('./RouteScene'))
import { Activity, ArrowDownLeft, ArrowUpRight, ChevronDown, Gauge, Play, Radio, RefreshCw, Search, ShieldCheck, Square, WalletCards } from 'lucide-react'
import type { BookQuote, Market } from '../core/arbitrage'
import { findOpportunities } from '../core/arbitrage'
import { connectMarketStream, loadMarkets } from '../core/binance'
import { createPaperAccount, PAPER_ACCOUNT_STORAGE_KEY, parsePaperAccount, recordPaperTrade } from '../core/paperTrading'
import type { PaperAccount } from '../core/paperTrading'
import AccountPanel from './AccountPanel'
import OpportunityHistory from './OpportunityHistory'
import ExecutionPanel from './ExecutionPanel'
import type { Account, Commission } from '../core/account'
import { readApi } from '../core/account'
import { validateRoute } from '../core/validation'
import type { ReferencePrice } from '../core/validation'

type StreamStatus = 'connecting' | 'loading' | 'live' | 'reconnecting' | 'error' | 'stopped'
const statusLabel: Record<StreamStatus, string> = { connecting: 'Conectando', loading: 'Cargando precios', live: 'En directo', reconnecting: 'Reconectando', error: 'Error de conexión', stopped: 'Pausado' }
const currency = (value: number, digits = 4) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value)
const readPaperAccount = (): PaperAccount => {
  try { return parsePaperAccount(window.localStorage.getItem(PAPER_ACCOUNT_STORAGE_KEY)) }
  catch { return createPaperAccount() }
}

export default function App() {
  const [markets, setMarkets] = useState<Market[]>([])
  const books = useRef(new Map<string, BookQuote>())
  const messages = useRef(0)
  const [now, setNow] = useState(Date.now())
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const lastMessage = useRef<number | null>(null)
  const [error, setError] = useState('')
  const [marketWarning, setMarketWarning] = useState('')
  const [marketReload, setMarketReload] = useState(0)
  const [isRunning, setIsRunning] = useState(true)
  const [startAsset, setStartAsset] = useState('USDT')
  const [account, setAccount] = useState<Account | null>(null)
  const [accountMode, setAccountMode] = useState(false)
  const [commissions, setCommissions] = useState(new Map<string, Commission>())
  const [referencePrices, setReferencePrices] = useState(new Map<string, ReferencePrice>())
  const [accountError, setAccountError] = useState('')
  const lookupPending = useRef(new Set<string>())
  const lookupGeneration = useRef(0)
  const retryAt = useRef(new Map<string, number>())
  const [amount, setAmount] = useState(68)
  const [feeBps, setFeeBps] = useState(10)
  const [slippageBps, setSlippageBps] = useState(5)
  const [minNetBps, setMinNetBps] = useState(10)
  const [paperAccount, setPaperAccount] = useState<PaperAccount>(readPaperAccount)
  const paperAccountRef = useRef(paperAccount)
  const [paperEnabled, setPaperEnabled] = useState(false)
  const [paperStatus, setPaperStatus] = useState('Pausado · no se ejecutan simulaciones automáticamente')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'opportunities' | 'markets'>('opportunities')

  useEffect(() => {
    let cancelled = false
    setMarketWarning('')
    if (!markets.length) setStatus('connecting')
    loadMarkets(startAsset, accountMode, warning => { if (!cancelled) setMarketWarning(warning) }).then((loaded) => { if (!cancelled) { setMarkets(loaded); setError('') } })
      .catch((cause: unknown) => { if (!cancelled) { const message = cause instanceof Error ? cause.message : 'No se pudieron cargar los mercados.'; setMarketWarning(message); if (!markets.length) { setError(message); setStatus('error') } } })
    return () => { cancelled = true }
  }, [startAsset, accountMode, marketReload])

  useEffect(() => {
    if (!isRunning || !markets.length) { if (!isRunning) setStatus('stopped'); return }
    const disconnect = connectMarketStream(markets, {
      onStatus: (nextStatus) => { setStatus(nextStatus); if (nextStatus === 'live') setError('') },
      onQuote: (quote) => { books.current.set(quote.symbol, quote); messages.current += 1; lastMessage.current = quote.receivedAt },
      onStats: ({ lastMessageAt }) => { if (lastMessageAt) lastMessage.current = lastMessageAt },
      onError: setError,
    })
    return disconnect
  }, [isRunning, markets])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])

  const candidates = useMemo(() => findOpportunities(markets, books.current, {
    startAsset, amount, feeBps: accountMode ? 0 : feeBps, slippageBps: accountMode ? 0 : slippageBps,
    minNetBps: accountMode ? 0 : minNetBps, maxAgeMs: 2_000,
  }, now), [markets, startAsset, amount, feeBps, slippageBps, minNetBps, now, accountMode])
  const evaluated = useMemo(() => accountMode && account ? candidates.map(route => validateRoute(route, markets, books.current, {
    account, commissions, referencePrices, slippageBps, minNetBps, now,
  })) : [], [accountMode, account, candidates, markets, commissions, referencePrices, slippageBps, minNetBps, now])
  const opportunities = accountMode ? evaluated.flatMap(result => result.opportunity ? [result.opportunity] : []).sort((a, b) => b.netBps - a.netBps) : candidates
  const rejectionCounts = new Map<string, number>()
  evaluated.forEach(result => { if (result.reason) rejectionCounts.set(result.reason, (rejectionCounts.get(result.reason) ?? 0) + 1) })
  const assets = [...new Set(['USDT', 'USDC', 'USDS', 'EUR', 'BTC', 'ETH', 'BNB', ...markets.flatMap(m => [m.baseAsset, m.quoteAsset]), ...(account?.balances.map(b => b.asset) ?? [])])].sort()
  const available = account?.balances.find(b => b.asset === startAsset)?.free ?? '0'
  const handleAccount = (next: Account | null) => {
    setAccount(next); setPaperEnabled(false)
    if (!next) { setAccountMode(false); return }
    setAccountMode(true); setCommissions(new Map()); setReferencePrices(new Map()); setAccountError('')
    const funded = next.balances.find(b => b.asset === startAsset && Number(b.free) > 0) ?? next.balances.find(b => ['USDC', 'USDS', 'USDT', 'EUR'].includes(b.asset) && Number(b.free) > 0) ?? next.balances.find(b => Number(b.free) > 0)
    if (funded) { setStartAsset(funded.asset); setAmount(Math.min(amount, Number(funded.free))) }
  }
  useEffect(() => {
    if (!accountMode || !account) return
    let cancelled = false
    const refresh = () => { void readApi<Account>('/api/account').then(next => { if (!cancelled) { setAccount(next); setAccountError('') } }).catch(cause => { if (!cancelled) setAccountError(cause instanceof Error ? cause.message : 'No se pudo actualizar el saldo') }) }
    const timer = window.setInterval(refresh, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [accountMode, Boolean(account)])
  useEffect(() => { lookupGeneration.current += 1; retryAt.current.clear() }, [accountMode, startAsset, account?.environment])
  useEffect(() => {
    if (!accountMode || !account || account.environment !== 'live' || !isRunning) return
    const generation = lookupGeneration.current
    // Bounded lazy queries: validate the best gross candidates first. Missing or
    // stale tariffs never fall back to a zero/manual fee in account mode.
    const symbols = [...new Set(candidates.slice(0, 20).flatMap(route => route.symbols))]
    const needed = symbols.filter(symbol => !lookupPending.current.has(symbol) && (retryAt.current.get(symbol) ?? 0) <= now &&
      (!commissions.has(symbol) || now - commissions.get(symbol)!.fetchedAt > 45_000 || !referencePrices.has(symbol) || now - referencePrices.get(symbol)!.fetchedAt > 15_000)).slice(0, 3)
    needed.forEach(symbol => {
      lookupPending.current.add(symbol); retryAt.current.set(symbol, now + 5_000)
      void Promise.all([readApi<Commission>(`/api/commission?symbol=${symbol}`), readApi<ReferencePrice>(`/api/reference-price?symbol=${symbol}`)])
        .then(([fee, price]) => { if (generation === lookupGeneration.current) { setCommissions(previous => new Map(previous).set(symbol, fee)); setReferencePrices(previous => new Map(previous).set(symbol, price)) } })
        .catch(cause => { if (generation === lookupGeneration.current) setAccountError(cause instanceof Error ? cause.message : 'No se pudieron verificar las tarifas') })
        .finally(() => lookupPending.current.delete(symbol))
    })
  }, [Math.floor(now / 1_000), accountMode, account?.environment, isRunning, startAsset])
  const booksReady = books.current.size
  const best = opportunities[0]
  const freshness = lastMessage.current ? Math.max(0, now - lastMessage.current) : null
  const visibleMarkets = markets.filter((market) => market.symbol.toLowerCase().includes(search.toLowerCase())).slice(0, 14)

  useEffect(() => {
    if (!paperEnabled || startAsset !== 'USDT' || status !== 'live' || !best) return
    const result = recordPaperTrade(paperAccountRef.current, best, now)
    if (!result.accepted) return
    paperAccountRef.current = result.account
    setPaperAccount(result.account)
    setPaperStatus(`Simulada ${result.trade.route.join(' → ')} · +${currency(result.trade.profit, 6)} USDT`)
    try { window.localStorage.setItem(PAPER_ACCOUNT_STORAGE_KEY, JSON.stringify(result.account)) } catch { setPaperStatus('Simulación en memoria · el navegador no permite guardar el historial') }
  }, [best, now, paperEnabled, status, startAsset])

  const resetPaperAccount = () => {
    if (!window.confirm('¿Reiniciar el saldo virtual y borrar el historial de simulaciones?')) return
    setPaperEnabled(false)
    const reset = createPaperAccount()
    paperAccountRef.current = reset
    setPaperAccount(reset)
    setPaperStatus('Saldo virtual reiniciado a 1.000,00 USDT')
    try { window.localStorage.setItem(PAPER_ACCOUNT_STORAGE_KEY, JSON.stringify(reset)) } catch { /* The account remains available for this session. */ }
  }

  return <div className="app-shell">
    <main className="main-content">
      <header className="topbar"><strong>Arbitrage Lab</strong><span>Binance Spot</span></header>
      <section className="page-heading"><div><div className="eyebrow">CENTRO DE OPERACIONES</div><h1>Tu actividad, en claro.</h1><p>El automático opera en el servidor. El laboratorio explora señales en este navegador.</p></div></section>
      <ExecutionPanel best={best} accountMode={accountMode}/>
      <Fold title="Cuenta y saldos" description={account ? `Cuenta consultada · ${account.environment}` : 'Consulta tu saldo en Binance; el automático usa las claves del servidor'}><AccountPanel onAccount={handleAccount}/></Fold>
      <Fold title="Historial de oportunidades" description="Señales registradas; una señal no es una orden"><OpportunityHistory opportunities={opportunities} live={status === 'live' && isRunning} config={{ startAsset, amount, feeMode: accountMode ? 'account' : 'manual', feeBps, slippageBps, minNetBps }}/></Fold>
      <Fold title="Laboratorio de rutas" description={`${opportunities.length} señales locales · ${statusLabel[status]} · no configura el automático`}>
        <div className="lab-toolbar"><p>Estos parámetros solo cambian la exploración y la simulación local.</p><button className="secondary-button" onClick={() => setIsRunning(running => !running)}>{isRunning ? 'Pausar escáner local' : 'Reanudar escáner local'}</button><button className="secondary-button" onClick={() => { books.current.clear(); lastMessage.current = null; messages.current = 0; setMarketReload(value => value + 1) }}>Recargar mercados</button></div>
        <div className="local-status">{statusLabel[status]} · {booksReady} / {markets.length} libros · {freshness === null ? 'Esperando precios' : `Último dato hace ${(freshness / 1000).toFixed(1)} s`}</div>
        {error && <p className="account-error" role="alert">{error}</p>}
      <section className="panel paper-panel">
        <div className="panel-heading"><div><h2>Evaluación de rutas</h2><p>{accountMode ? 'Saldo y tarifas reales · estimación conservadora · sin ejecución' : 'Exploración pública con costos manuales'}</p></div></div>
        <div className="commission-form"><label htmlFor="start-asset">Activo inicial</label><select id="start-asset" value={startAsset} onChange={event => { setStartAsset(event.target.value); setPaperEnabled(false) }}>{assets.map(asset => <option key={asset}>{asset}</option>)}</select><label htmlFor="route-amount">Importe</label><input id="route-amount" type="number" min="0" step="any" value={amount} onChange={event => setAmount(Number(event.target.value))}/><label><input type="checkbox" checked={accountMode} disabled={!account} onChange={event => { setAccountMode(event.target.checked); setPaperEnabled(false) }}/> Usar mi cuenta</label></div>
        {accountMode && <div className="paper-note"><ShieldCheck size={14}/><span>Disponible: {available} {startAsset}. {account?.environment === 'testnet' ? 'Testnet: evaluación bloqueada porque el stream usa precios live.' : account?.canTrade === false ? 'Binance indica que esta cuenta no puede operar.' : 'Se comprueban saldo, cantidades, mínimos, liquidez del primer nivel y tarifas. Las restricciones específicas de tu cuenta o región aún pueden impedir una orden.'}</span></div>}
        {marketWarning && <p className="account-error" role="status">{marketWarning}</p>}
        {accountError && <p className="account-error" role="alert">{accountError}</p>}
        {accountMode && <div className="paper-note"><span>{candidates.length} rutas con margen bruto · {opportunities.length} superan validación y umbral neto. Se consultan primero las 20 mejores rutas brutas.<br/>{[...rejectionCounts].slice(0, 6).map(([reason, count]) => <span key={reason}>{count} × {reason}<br/></span>)}{!candidates.length && 'Sin rutas frescas con margen bruto para este activo e importe. No implica que debas aumentar el capital.'}</span></div>}
      </section>


        <Fold title="Costes y umbral del laboratorio" description="Independientes de los parámetros del servidor"><div className="settings-modal"><label>Importe por operación <span>{startAsset}</span><input type="number" min="0" step="any" value={amount} onChange={(event) => setAmount(Number(event.target.value))}/></label><label>Comisión estimada <span>puntos base por pata</span><input disabled={accountMode} type="number" min="0" max="9999" value={feeBps} onChange={(event) => setFeeBps(Number(event.target.value))}/></label><label>Deslizamiento estimado <span>puntos base por pata</span><input type="number" min="0" max="9999" value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))}/></label><label>Umbral mínimo de señal <span>puntos base netos</span><input type="number" min="0" value={minNetBps} onChange={(event) => setMinNetBps(Number(event.target.value))}/></label><div className="modal-note"><ShieldCheck size={15}/> {accountMode ? 'Comisiones automáticas verificadas por mercado. El deslizamiento sigue siendo un supuesto.' : 'Costos manuales para exploración; conecta tu cuenta para verificar tarifas y saldo.'}</div></div></Fold>
        <Suspense fallback={<p className="paper-note">Cargando vista de rutas…</p>}><RouteScene opportunity={best}/></Suspense>
      <div className="panel opportunities-panel"><div className="panel-heading"><div><div className="panel-title"><span className="title-icon"><Activity size={16}/></span><h2>Rutas detectadas</h2><span className="count-pill">{opportunities.length}</span></div><p>{startAsset} → activo intermedio → activo intermedio → {startAsset}</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>RUTA</th><th>3 MERCADOS</th><th>ENTRADA</th><th>SALIDA EST.</th><th>NETO EST.</th><th>EDAD</th></tr></thead><tbody>
          {opportunities.slice(0, 8).map((opportunity, index) => <tr key={opportunity.symbols.join('-')}><td><span className="route-index">{String(index + 1).padStart(2, '0')}</span><span className="route-text">{opportunity.route.map((asset, i) => <span key={`${asset}-${i}`} className={i === 3 ? 'route-end' : ''}>{i > 0 && <i>→</i>}{asset}</span>)}</span></td><td><span className="symbol-stack">{opportunity.symbols.map((symbol) => <code key={symbol}>{symbol}</code>)}</span></td><td className="numeric">{currency(opportunity.input, 2)} <small>{startAsset}</small></td><td className="numeric">{currency(opportunity.output, 5)} <small>{startAsset}</small></td><td><span className="profit-pill">+{currency(opportunity.netBps / 100, 3)}%</span></td><td className="age-cell">{opportunity.oldestQuoteMs} ms</td></tr>)}
          {!opportunities.length && <tr><td colSpan={6}><div className="empty-state"><span className="empty-icon"><Gauge size={19}/></span><b>{status === 'loading' || status === 'connecting' ? 'Preparando los mercados…' : 'Sin oportunidades por ahora'}</b><span>{status === 'live' ? 'Las rutas deben superar comisiones, deslizamiento y disponibilidad estimada.' : 'Al recibir cotizaciones recientes aparecerán las señales calculadas.'}</span></div></td></tr>}
        </tbody></table></div><div className="panel-footer"><span><span className="live-dot"/> Actualizado en tiempo real</span><span>{accountMode ? 'Comisiones de tu cuenta por mercado' : `Comisión manual: ${(feeBps / 100).toFixed(2)}% por tramo`} + {(slippageBps / 100).toFixed(2)}% deslizamiento</span></div></div>


        <Fold title="Cotizaciones de mercados" description="Precios públicos bid / ask">      <section className="panel market-panel"><div className="panel-heading"><div><div className="panel-title"><span className="title-icon blue"><Radio size={16}/></span><h2>Mercados monitorizados</h2><span className="count-pill">{markets.length || '—'}</span></div><p>Selección Spot por volumen con activos de cruce comunes.</p></div><div className="market-tools"><label className="search-field"><Search size={14}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar par…"/></label><div className="tab-control"><button className={tab === 'opportunities' ? 'tab-active' : ''} onClick={() => setTab('opportunities')}>Resumen</button><button className={tab === 'markets' ? 'tab-active' : ''} onClick={() => setTab('markets')}>Precios</button></div></div></div><div className="market-cards">{visibleMarkets.slice(0, tab === 'markets' ? 14 : 7).map((market, index) => { const quote = books.current.get(market.symbol); const bid = Number(quote?.bidPrice); const ask = Number(quote?.askPrice); const mid = bid && ask ? (bid + ask) / 2 : null; return <div className="market-card" key={market.symbol}><div className="market-card-top"><span className={`coin-icon coin-${index % 5}`}>{market.baseAsset.slice(0, 1)}</span><span className="market-symbol"><b>{market.baseAsset}<small>/{market.quoteAsset}</small></b><span>{market.symbol}</span></span><span className="market-live"><i/></span></div><div className="market-price">{mid ? currency(mid, mid < 1 ? 7 : 4) : 'Esperando tick'}</div><div className="market-card-bottom"><span><ArrowDownLeft size={12}/> BID {quote ? currency(bid, 6) : '—'}</span><span><ArrowUpRight size={12}/> ASK {quote ? currency(ask, 6) : '—'}</span></div></div> })}</div><div className="panel-footer"><span>Mostrando {visibleMarkets.slice(0, tab === 'markets' ? 14 : 7).length} de {markets.length} pares seguidos</span><span><span className="live-dot"/> Precios del libro superior</span></div></section>

</Fold>
        <Fold title="Simulación con saldo virtual" description="USDT virtuales; no modifica tu cuenta Binance">      <section className="panel paper-panel"><div className="panel-heading"><div><div className="panel-title"><span className="title-icon cyan"><WalletCards size={16}/></span><h2>Paper trading</h2><span className={`paper-badge ${paperEnabled ? 'running' : ''}`}>{paperEnabled ? 'SIMULACIÓN ACTIVA' : 'PAUSADO'}</span></div><p>Saldo virtual persistente en USDT · disponible al seleccionar USDT · sin órdenes reales</p></div><div className="paper-actions"><button className={paperEnabled ? 'stop-button' : 'primary-button'} disabled={!paperEnabled && (status !== 'live' || startAsset !== 'USDT')} onClick={() => { const next = !paperEnabled; setPaperEnabled(next); setPaperStatus(next ? 'Esperando una señal neta con cotizaciones recientes' : 'Pausado · no se ejecutan simulaciones automáticamente') }}>{paperEnabled ? <><Square size={13} fill="currentColor"/> Pausar</> : <><Play size={14} fill="currentColor"/> Iniciar simulación</>}</button><button className="secondary-button" onClick={resetPaperAccount}><RefreshCw size={14}/> Reiniciar saldo</button></div></div>
        <div className="paper-summary"><div><span>Saldo virtual</span><b>{currency(paperAccount.balance, 6)} <small>USDT</small></b></div><div><span>Resultado realizado</span><b className={paperAccount.balance >= paperAccount.initialBalance ? 'paper-positive' : 'paper-negative'}>{paperAccount.balance >= paperAccount.initialBalance ? '+' : ''}{currency(paperAccount.balance - paperAccount.initialBalance, 6)} <small>USDT</small></b></div><div><span>Operaciones simuladas</span><b>{paperAccount.totalTrades}</b></div><div><span>Estado</span><b className="paper-status">{paperStatus}</b></div></div>
        <div className="paper-note"><ShieldCheck size={14}/><span>Simula una ruta por oportunidad, con los costes configurados y una espera de 60 s por ruta. Usa mejor bid/ask y liquidez del primer nivel; no modela fills parciales ni latencia de ejecución. Si comisión o deslizamiento están en 0, el saldo reflejará ese supuesto.</span></div>
        <div className="paper-trades-wrap"><table className="paper-trades"><thead><tr><th>HORA</th><th>RUTA SIMULADA</th><th>ENTRADA</th><th>SALIDA</th><th>RESULTADO</th><th>EDAD</th></tr></thead><tbody>{paperAccount.trades.slice(0, 5).map((trade) => <tr key={trade.id}><td>{new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(trade.executedAt)}</td><td>{trade.route.join(' → ')}</td><td>{currency(trade.input, 5)} USDT</td><td>{currency(trade.output, 6)} USDT</td><td className={trade.profit >= 0 ? 'paper-positive' : 'paper-negative'}>{trade.profit >= 0 ? '+' : ''}{currency(trade.profit, 6)} USDT</td><td>{trade.oldestQuoteMs} ms</td></tr>)}{!paperAccount.trades.length && <tr><td colSpan={6} className="paper-empty">Aún no hay operaciones simuladas. Inicia el modo y espera una señal neta.</td></tr>}</tbody></table></div>
        <div className="panel-footer"><span><span className={paperEnabled ? 'live-dot' : 'status-dot'}/>{paperEnabled ? 'La simulación solo corre mientras esta pestaña está abierta' : 'Al pausar, el saldo y el historial quedan guardados en este navegador'}</span><span>Saldo inicial: {currency(paperAccount.initialBalance, 2)} USDT</span></div>
      </section>

</Fold>
      </Fold>
      <footer className="page-footer">Los retornos de las señales son estimaciones. Consulta las operaciones para ver resultados ejecutados.</footer>
    </main>
  </div>
}

function Fold({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <details className="fold"><summary><span><strong>{title}</strong><small>{description}</small></span><ChevronDown size={18}/></summary><div className="fold-body">{children}</div></details>
}
