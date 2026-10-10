import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, ArrowDownLeft, ArrowUpRight, Bell, ChevronDown, CircleHelp, Clock3, Cpu, FlaskConical, Gauge, LayoutDashboard, ListFilter, Menu, Play, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Square, WalletCards, Wifi, X } from 'lucide-react'
import type { BookQuote, Market } from '../core/arbitrage'
import { findOpportunities } from '../core/arbitrage'
import { connectMarketStream, loadMarkets } from '../core/binance'
import { createPaperAccount, PAPER_ACCOUNT_STORAGE_KEY, parsePaperAccount, recordPaperTrade } from '../core/paperTrading'
import type { PaperAccount } from '../core/paperTrading'
import AccountPanel from './AccountPanel'

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
  const [isRunning, setIsRunning] = useState(true)
  const [amount, setAmount] = useState(68)
  const [feeBps, setFeeBps] = useState(10)
  const [slippageBps, setSlippageBps] = useState(5)
  const [minNetBps, setMinNetBps] = useState(10)
  const [paperAccount, setPaperAccount] = useState<PaperAccount>(readPaperAccount)
  const paperAccountRef = useRef(paperAccount)
  const [paperEnabled, setPaperEnabled] = useState(false)
  const [paperStatus, setPaperStatus] = useState('Pausado · no se ejecutan simulaciones automáticamente')
  const [showSettings, setShowSettings] = useState(false)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'opportunities' | 'markets'>('opportunities')

  useEffect(() => {
    let cancelled = false
    setStatus('connecting')
    loadMarkets().then((loaded) => { if (!cancelled) setMarkets(loaded) })
      .catch((cause: unknown) => { if (!cancelled) { setError(cause instanceof Error ? cause.message : 'No se pudieron cargar los mercados.'); setStatus('error') } })
    return () => { cancelled = true }
  }, [])

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

  const opportunities = useMemo(() => findOpportunities(markets, books.current, {
    startAsset: 'USDT', amount, feeBps, slippageBps, minNetBps, maxAgeMs: 2_000,
  }, now), [markets, amount, feeBps, slippageBps, minNetBps, now])
  const booksReady = books.current.size
  const best = opportunities[0]
  const freshness = lastMessage.current ? Math.max(0, now - lastMessage.current) : null
  const visibleMarkets = markets.filter((market) => market.symbol.toLowerCase().includes(search.toLowerCase())).slice(0, 14)

  useEffect(() => {
    if (!paperEnabled || status !== 'live' || !best) return
    const result = recordPaperTrade(paperAccountRef.current, best, now)
    if (!result.accepted) return
    paperAccountRef.current = result.account
    setPaperAccount(result.account)
    setPaperStatus(`Simulada ${result.trade.route.join(' → ')} · +${currency(result.trade.profit, 6)} USDT`)
    try { window.localStorage.setItem(PAPER_ACCOUNT_STORAGE_KEY, JSON.stringify(result.account)) } catch { setPaperStatus('Simulación en memoria · el navegador no permite guardar el historial') }
  }, [best, now, paperEnabled, status])

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
    <aside className="sidebar">
      <a className="brand" href="#top"><span className="brand-mark"><Activity size={20}/></span><span>ARBITRAGE<span className="brand-light">LAB</span><small>MARKET RESEARCH</small></span></a>
      <div className="workspace-label">WORKSPACE <ChevronDown size={12}/></div>
      <div className="workspace-card"><span className="workspace-icon"><FlaskConical size={17}/></span><span><b>Spot Research</b><small>Entorno de simulación</small></span><span className="live-dot"/></div>
      <div className="nav-caption">MONITOR</div>
      <nav><button className="nav-item active"><LayoutDashboard size={17}/> Panel <span className="nav-active-mark"/></button><button className="nav-item"><Activity size={17}/> Oportunidades <span className="nav-count">{opportunities.length}</span></button><button className="nav-item"><WalletCards size={17}/> Simulaciones</button><button className="nav-item"><Radio size={17}/> Mercados</button></nav>
      <div className="sidebar-bottom"><div className="environment"><span className="environment-icon"><ShieldCheck size={16}/></span><span><b>Solo lectura</b><small>Claves solo en backend</small></span></div><button className="nav-item muted"><Settings2 size={17}/> Preferencias</button><div className="profile"><div className="avatar">JP</div><div><b>Research desk</b><small>Local workspace</small></div><ChevronDown size={15}/></div></div>
    </aside>

    <main id="top" className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span className="slash">/</span><b>Panel de mercado</b></div><div className="top-actions"><span className="market-session"><span className="live-dot"/> MERCADO CRIPTO 24/7</span><button className="icon-button" aria-label="Notificaciones"><Bell size={17}/><i/></button><button className="help-button"><CircleHelp size={16}/> Ayuda</button><button className="mobile-menu" aria-label="Menú"><Menu size={19}/></button></div></header>

      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> BINANCE SPOT <span className="eyebrow-separator">·</span> TRIANGULAR SCANNER</div><h1>Market overview<span className="heading-period">.</span></h1><p>Señales indicativas calculadas sobre el mejor bid/ask público.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => setShowSettings(true)}><SlidersHorizontal size={16}/> Parámetros</button><button className={isRunning ? 'stop-button' : 'primary-button'} onClick={() => setIsRunning((running) => !running)}>{isRunning ? <><Square size={14} fill="currentColor"/> Pausar monitor</> : <><Play size={15} fill="currentColor"/> Reanudar</>}</button></div></section>

      <section className="connection-banner"><div className="connection-left"><span className={`connection-icon ${status}`}><Wifi size={17}/></span><div><b>{statusLabel[status]}</b><span>{error || (lastMessage.current ? `Última actualización hace ${Math.floor(freshness! / 1000)} s` : 'Esperando primeras cotizaciones de Binance')}</span></div></div><div className="connection-meta"><span><i className={status === 'live' ? 'status-dot online' : 'status-dot'}/>{status === 'live' ? 'STREAM ACTIVO' : 'STREAM'}</span><span className="connection-divider"/><span>{booksReady.toLocaleString()} <small>/ {markets.length || '—'} libros</small></span><span className="connection-divider"/><span><Activity size={14}/> {messages.current.toLocaleString()} <small>ticks</small></span></div><button className="connection-action" onClick={() => { books.current.clear(); lastMessage.current = null; messages.current = 0; setError(''); setIsRunning(false); window.setTimeout(() => setIsRunning(true), 80) }} aria-label="Reconectar"><RefreshCw size={15}/></button></section>

      <section className="metric-grid">
        <Metric label="OPORTUNIDADES NETAS" value={String(opportunities.length).padStart(2, '0')} unit="señales" icon={<Activity size={17}/>} tone="green" foot="Tras costes estimados"/>
        <Metric label="MEJOR RETORNO ESTIMADO" value={best ? `+${currency(best.netBps / 100, 3)}%` : '—'} unit="neto" icon={<ArrowUpRight size={17}/>} tone="green" foot={best ? `${best.route.join(' → ')}` : 'Sin señal por encima del umbral'}/>
        <Metric label="MERCADOS SUSCRITOS" value={markets.length ? markets.length.toLocaleString() : '—'} unit="pares" icon={<Radio size={17}/>} tone="blue" foot="Spot · activos · selección por volumen"/>
        <Metric label="FRESCURA DE COTIZACIÓN" value={freshness !== null ? `${(freshness / 1000).toFixed(1)}s` : '—'} unit="ahora" icon={<Clock3 size={17}/>} tone={freshness !== null && freshness < 2_000 ? 'green' : 'amber'} foot={`${messages.current.toLocaleString()} cambios recibidos`}/>
      </section>

      <section className="content-grid"><div className="panel opportunities-panel"><div className="panel-heading"><div><div className="panel-title"><span className="title-icon"><Activity size={16}/></span><h2>Rutas detectadas</h2><span className="count-pill">{opportunities.length}</span></div><p>USDT → activo intermedio → activo intermedio → USDT</p></div><button className="icon-button panel-menu" aria-label="Filtrar rutas"><ListFilter size={17}/></button></div>
        <div className="table-wrap"><table><thead><tr><th>RUTA</th><th>3 MERCADOS</th><th>ENTRADA</th><th>SALIDA EST.</th><th>NETO EST.</th><th>EDAD</th></tr></thead><tbody>
          {opportunities.slice(0, 8).map((opportunity, index) => <tr key={opportunity.symbols.join('-')}><td><span className="route-index">{String(index + 1).padStart(2, '0')}</span><span className="route-text">{opportunity.route.map((asset, i) => <span key={`${asset}-${i}`} className={i === 3 ? 'route-end' : ''}>{i > 0 && <i>→</i>}{asset}</span>)}</span></td><td><span className="symbol-stack">{opportunity.symbols.map((symbol) => <code key={symbol}>{symbol}</code>)}</span></td><td className="numeric">{currency(opportunity.input, 2)} <small>USDT</small></td><td className="numeric">{currency(opportunity.output, 5)} <small>USDT</small></td><td><span className="profit-pill">+{currency(opportunity.netBps / 100, 3)}%</span></td><td className="age-cell">{opportunity.oldestQuoteMs} ms</td></tr>)}
          {!opportunities.length && <tr><td colSpan={6}><div className="empty-state"><span className="empty-icon"><Gauge size={19}/></span><b>{status === 'loading' || status === 'connecting' ? 'Preparando los mercados…' : 'Sin oportunidades por ahora'}</b><span>{status === 'live' ? 'Las rutas deben superar comisiones, deslizamiento y disponibilidad estimada.' : 'Al recibir cotizaciones recientes aparecerán las señales calculadas.'}</span></div></td></tr>}
        </tbody></table></div><div className="panel-footer"><span><span className="live-dot"/> Actualizado en tiempo real</span><span>Costes por pata: {(feeBps / 100).toFixed(2)}% comisión + {(slippageBps / 100).toFixed(2)}% deslizamiento</span></div></div>

        <div className="right-column"><div className="panel signal-panel"><div className="panel-heading compact"><div><div className="panel-title"><span className="title-icon cyan"><Gauge size={16}/></span><h2>Motor de señales</h2></div><p>Estado de evaluación local</p></div><span className="live-chip">{status === 'live' ? 'ACTIVO' : status === 'stopped' ? 'PAUSADO' : 'INICIANDO'}</span></div><div className="engine-visual"><div className="engine-ring"><div className="engine-core"><Cpu size={24}/><span>SCAN</span></div><i className="orbit orbit-one"/><i className="orbit orbit-two"/><i className="orbit orbit-three"/></div><div className="engine-details"><div><span>Universo seguido</span><b>{markets.length || '—'} <small>pares</small></b></div><div><span>Ciclos frescos</span><b>{opportunities.length} <small>rutas</small></b></div><div><span>Latencia local</span><b>{freshness === null ? '—' : `${freshness} ms`}</b></div></div></div><div className="engine-note"><ShieldCheck size={15}/><span>Solo datos públicos. El motor simula conversiones; no envía órdenes.</span></div></div>

        <div className="panel recent-panel"><div className="panel-heading compact"><div><div className="panel-title"><span className="title-icon amber"><Clock3 size={16}/></span><h2>Actividad reciente</h2></div><p>Actualizaciones del monitor</p></div><button className="more-button">Ver todo <ArrowUpRight size={13}/></button></div><ActivityRow icon={<Radio size={14}/>} title="Stream de mercado" body={status === 'live' ? 'Conexión pública activa' : statusLabel[status]} time={lastMessage.current ? `${Math.max(0, Math.floor((now - lastMessage.current) / 1000))}s` : '—'} tone="green"/><ActivityRow icon={<WalletCards size={14}/>} title="Capital virtual" body={`${currency(amount, 2)} USDT por simulación`} time="config" tone="blue"/><ActivityRow icon={<SlidersHorizontal size={14}/>} title="Umbral de señal" body={`Mínimo ${minNetBps} puntos base netos`} time="config" tone="amber"/></div></div></section>

      <AccountPanel/>
      <section className="panel paper-panel"><div className="panel-heading"><div><div className="panel-title"><span className="title-icon cyan"><WalletCards size={16}/></span><h2>Paper trading</h2><span className={`paper-badge ${paperEnabled ? 'running' : ''}`}>{paperEnabled ? 'SIMULACIÓN ACTIVA' : 'PAUSADO'}</span></div><p>Saldo virtual persistente · sin conexión a cuentas ni órdenes reales</p></div><div className="paper-actions"><button className={paperEnabled ? 'stop-button' : 'primary-button'} disabled={!paperEnabled && status !== 'live'} onClick={() => { const next = !paperEnabled; setPaperEnabled(next); setPaperStatus(next ? 'Esperando una señal neta con cotizaciones recientes' : 'Pausado · no se ejecutan simulaciones automáticamente') }}>{paperEnabled ? <><Square size={13} fill="currentColor"/> Pausar</> : <><Play size={14} fill="currentColor"/> Iniciar simulación</>}</button><button className="secondary-button" onClick={resetPaperAccount}><RefreshCw size={14}/> Reiniciar saldo</button></div></div>
        <div className="paper-summary"><div><span>Saldo virtual</span><b>{currency(paperAccount.balance, 6)} <small>USDT</small></b></div><div><span>Resultado realizado</span><b className={paperAccount.balance >= paperAccount.initialBalance ? 'paper-positive' : 'paper-negative'}>{paperAccount.balance >= paperAccount.initialBalance ? '+' : ''}{currency(paperAccount.balance - paperAccount.initialBalance, 6)} <small>USDT</small></b></div><div><span>Operaciones simuladas</span><b>{paperAccount.totalTrades}</b></div><div><span>Estado</span><b className="paper-status">{paperStatus}</b></div></div>
        <div className="paper-note"><ShieldCheck size={14}/><span>Simula una ruta por oportunidad, con los costes configurados y una espera de 60 s por ruta. Usa mejor bid/ask y liquidez del primer nivel; no modela fills parciales ni latencia de ejecución. Si comisión o deslizamiento están en 0, el saldo reflejará ese supuesto.</span></div>
        <div className="paper-trades-wrap"><table className="paper-trades"><thead><tr><th>HORA</th><th>RUTA SIMULADA</th><th>ENTRADA</th><th>SALIDA</th><th>RESULTADO</th><th>EDAD</th></tr></thead><tbody>{paperAccount.trades.slice(0, 5).map((trade) => <tr key={trade.id}><td>{new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(trade.executedAt)}</td><td>{trade.route.join(' → ')}</td><td>{currency(trade.input, 5)} USDT</td><td>{currency(trade.output, 6)} USDT</td><td className={trade.profit >= 0 ? 'paper-positive' : 'paper-negative'}>{trade.profit >= 0 ? '+' : ''}{currency(trade.profit, 6)} USDT</td><td>{trade.oldestQuoteMs} ms</td></tr>)}{!paperAccount.trades.length && <tr><td colSpan={6} className="paper-empty">Aún no hay operaciones simuladas. Inicia el modo y espera una señal neta.</td></tr>}</tbody></table></div>
        <div className="panel-footer"><span><span className={paperEnabled ? 'live-dot' : 'status-dot'}/>{paperEnabled ? 'La simulación solo corre mientras esta pestaña está abierta' : 'Al pausar, el saldo y el historial quedan guardados en este navegador'}</span><span>Saldo inicial: {currency(paperAccount.initialBalance, 2)} USDT</span></div>
      </section>

      <section className="panel market-panel"><div className="panel-heading"><div><div className="panel-title"><span className="title-icon blue"><Radio size={16}/></span><h2>Mercados monitorizados</h2><span className="count-pill">{markets.length || '—'}</span></div><p>Selección Spot por volumen con activos de cruce comunes.</p></div><div className="market-tools"><label className="search-field"><Search size={14}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar par…"/></label><div className="tab-control"><button className={tab === 'opportunities' ? 'tab-active' : ''} onClick={() => setTab('opportunities')}>Resumen</button><button className={tab === 'markets' ? 'tab-active' : ''} onClick={() => setTab('markets')}>Precios</button></div></div></div><div className="market-cards">{visibleMarkets.slice(0, tab === 'markets' ? 14 : 7).map((market, index) => { const quote = books.current.get(market.symbol); const bid = Number(quote?.bidPrice); const ask = Number(quote?.askPrice); const mid = bid && ask ? (bid + ask) / 2 : null; return <div className="market-card" key={market.symbol}><div className="market-card-top"><span className={`coin-icon coin-${index % 5}`}>{market.baseAsset.slice(0, 1)}</span><span className="market-symbol"><b>{market.baseAsset}<small>/{market.quoteAsset}</small></b><span>{market.symbol}</span></span><span className="market-live"><i/></span></div><div className="market-price">{mid ? currency(mid, mid < 1 ? 7 : 4) : 'Esperando tick'}</div><div className="market-card-bottom"><span><ArrowDownLeft size={12}/> BID {quote ? currency(bid, 6) : '—'}</span><span><ArrowUpRight size={12}/> ASK {quote ? currency(ask, 6) : '—'}</span></div></div> })}</div><div className="panel-footer"><span>Mostrando {visibleMarkets.slice(0, tab === 'markets' ? 14 : 7).length} de {markets.length} pares seguidos</span><span><span className="live-dot"/> Precios del libro superior</span></div></section>

      <footer className="page-footer"><span>ARBITRAGE LAB <i>·</i> PROTOTIPO DE INVESTIGACIÓN</span><span><ShieldCheck size={13}/> Sin ejecución de órdenes</span><a href="https://developers.binance.com/en/docs/products/spot/web-socket-streams" target="_blank" rel="noreferrer">Docs de Binance <ArrowUpRight size={12}/></a></footer>
    </main>

    {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}><section className="settings-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> CONFIGURACIÓN</div><h2>Parámetros de simulación</h2><p>Los costes se aplican a cada una de las tres conversiones.</p></div><button className="icon-button" onClick={() => setShowSettings(false)} aria-label="Cerrar"><X size={17}/></button></div><label>Importe por operación <span>USDT</span><input type="number" min="1" value={amount} onChange={(event) => setAmount(Number(event.target.value))}/></label><label>Comisión estimada <span>puntos base por pata</span><input type="number" min="0" max="9999" value={feeBps} onChange={(event) => setFeeBps(Number(event.target.value))}/></label><label>Deslizamiento estimado <span>puntos base por pata</span><input type="number" min="0" max="9999" value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))}/></label><label>Umbral mínimo de señal <span>puntos base netos</span><input type="number" min="0" value={minNetBps} onChange={(event) => setMinNetBps(Number(event.target.value))}/></label><div className="modal-note"><ShieldCheck size={15}/> Estos valores son supuestos manuales, no tarifas verificadas de tu cuenta.</div><button className="primary-button modal-apply" onClick={() => setShowSettings(false)}>Aplicar parámetros</button></section></div>}
  </div>
}

function Metric({ label, value, unit, icon, tone, foot }: { label: string; value: string; unit: string; icon: ReactNode; tone: string; foot: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><i className={`metric-icon ${tone}`}>{icon}</i></div><div className="metric-value">{value}<small>{unit}</small></div><div className="metric-foot"><i/> {foot}</div></article>
}

function ActivityRow({ icon, title, body, time, tone }: { icon: ReactNode; title: string; body: string; time: string; tone: string }) {
  return <div className="activity-row"><span className={`activity-icon ${tone}`}>{icon}</span><span className="activity-copy"><b>{title}</b><small>{body}</small></span><small className="activity-time">{time}</small></div>
}
