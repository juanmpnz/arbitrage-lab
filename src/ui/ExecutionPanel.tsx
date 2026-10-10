import { useEffect, useState } from 'react'
import { ShieldCheck, RefreshCw, Square } from 'lucide-react'
import type { Opportunity } from '../core/arbitrage'
import { readApi } from '../core/account'
type Run = { id: string; status: string; startedAt: number; input: number; asset: string; message: string; legs: { symbol: string; side: string; status: string }[]; balancesAfter?: { asset: string; free: string; locked: string }[] }
type Automatic = { enabled: boolean; running: boolean; connection?: string; cycles?: number; grossCandidates?: number; lastReason?: string; lastQuoteAt?: number | null }
type Status = { automatic?: Automatic; enabled: boolean; environment: string; asset: string; busy: boolean; stopped: boolean; reserved: number; limit: number; runs: Run[] }
type Preview = { token: string; expiresAt: number; environment: string; asset: string; input: number; output: number; reserved: number; legs: { symbol: string; side: string; price: string; quantity: string }[] }
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  let data: T & { error?: string }
  try { data = await response.json() as T & { error?: string } } catch { throw new Error('Sin respuesta del backend. Actualiza el estado; no repitas el envío.') }
  if (!response.ok) throw new Error(data.error ?? 'La ejecución no pudo continuar.')
  return data
}
export default function ExecutionPanel({ best, accountMode }: { best?: Opportunity; accountMode: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [symbols, setSymbols] = useState('')
  const [amount, setAmount] = useState(6.6)
  const refresh = async () => {
    try { setStatus(await readApi<Status>('/api/execution')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo actualizar el ejecutor') }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer) }, [])
  const act = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Error de ejecución') } finally { setBusy(false); void refresh() } }
  const canPreview = !status?.automatic?.enabled && status?.enabled && !status.busy && !status.stopped && !busy && !status.runs.some(run => run.status === 'REVIEW')
  return <section className="panel paper-panel">
    <div className="panel-heading"><div><div className="panel-title"><span className="title-icon amber"><ShieldCheck size={16}/></span><h2>Ejecución Spot</h2><span className="paper-badge">{status?.enabled ? status.environment === 'live' ? status.automatic?.enabled ? 'DINERO REAL · AUTO' : 'DINERO REAL · MANUAL' : 'TESTNET' : 'DESACTIVADA'}</span></div><p>Presupuesto acumulado máximo: 7 {status?.asset ?? 'USDS'} · {status?.automatic?.enabled ? 'monitor y ejecución en el backend' : 'ejecución manual'}</p></div><div className="paper-actions"><button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={14}/> Actualizar estado</button><button className="stop-button" disabled={!status?.enabled} onClick={() => void act(async () => { await post('/api/execution/stop', {}); setPreview(null) })}><Square size={14}/> Detener siguientes tramos</button></div></div>
    {!status?.enabled && <div className="paper-note"><span>Configura BINANCE_TRADING_ENABLED=true en el .env y habilita trading Spot en la clave para operar. No necesita permisos de retiros. La cuenta puede consultarse sin activar este módulo.</span></div>}
    {error && <p className="account-error" role="alert">{error}</p>}
    {!status?.automatic?.enabled && <div className="commission-form"><label htmlFor="execution-symbols">Tres pares en orden</label><input id="execution-symbols" value={symbols} onChange={event => { setSymbols(event.target.value); setPreview(null) }} placeholder="PAR1, PAR2, PAR3"/><label htmlFor="execution-amount">Importe inicial ({status?.asset ?? 'USDS'})</label><input id="execution-amount" type="number" min="0" max="6.6" step="any" value={amount} onChange={event => { setAmount(Number(event.target.value)); setPreview(null) }}/><button className="secondary-button" disabled={!best || !accountMode || best.route[0] !== status?.asset || busy} onClick={() => { if (best) { setSymbols(best.symbols.join(', ')); setAmount(Math.min(best.input, 6.6)); setPreview(null) } }}>Usar mejor ruta</button><button className="primary-button" disabled={!canPreview || !symbols} onClick={() => void act(async () => { setPreview(null); setPreview(await post<Preview>('/api/execution/preview', { symbols: symbols.split(',').map(s => s.trim().toUpperCase()), amount })) })}>Verificar operación</button></div>}
    {status?.automatic?.enabled && <div className="paper-note"><span><b>Automático: {status.automatic.running ? 'ACTIVO' : 'DETENIDO'}</b> · Stream: {status.automatic.connection} · {status.automatic.cycles ?? 0} ciclos seguidos · {status.automatic.grossCandidates ?? 0} candidatas brutas.<br/>{status.automatic.lastReason}<br/>Funciona sin navegador, mientras el proceso backend y su conexión sigan activos. No exige elegir una ruta ni pulsar Ejecutar.</span></div>}
    {status && <div className="paper-note"><span>Presupuesto reservado: {status.reserved.toFixed(4)} / 7 {status.asset}. {status.stopped ? 'Detenido para esta sesión del servidor.' : status.busy ? 'Operación en curso.' : 'El presupuesto se conserva al reiniciar.'} Se permiten hasta 6,6 por intento para reservar margen de costos.</span></div>}
    {preview && <div className="paper-note"><span>Plan {preview.environment}: {preview.input} {preview.asset} → {preview.output.toFixed(8)} estimados. Reserva: {preview.reserved.toFixed(4)}.<br/>{preview.legs.map(leg => <span key={leg.symbol}>{leg.side} {leg.symbol}: {leg.quantity} a precio límite {leg.price}<br/></span>)}<button className="stop-button" disabled={busy || !canPreview || Date.now() > preview.expiresAt} onClick={() => { const token = preview.token; setPreview(null); void act(async () => { const run = await post<Run>('/api/execution/run', { token }); if (run.status !== 'COMPLETED') setError(run.message) }) }}>{preview.environment === 'live' ? 'Ejecutar este ciclo con dinero real' : 'Ejecutar en Testnet'}</button></span></div>}
    <div className="paper-note"><span>Si un tramo expira, falla o queda incierto, se detiene el ciclo. Pueden quedar activos intermedios: el sistema no los liquida automáticamente. Consulta el detalle y tu cuenta Binance. El resultado puede ser una pérdida; el retorno mostrado es una estimación.</span></div>
    {status?.runs.slice(0, 10).map(run => <details className="paper-note" key={run.id}><summary>{new Date(run.startedAt).toLocaleString()} · {run.input} {run.asset} · {run.status}</summary><p>{run.message}</p>{run.legs.map((leg, i) => <p key={i}>{i + 1}. {leg.side} {leg.symbol} · {leg.status}</p>)}<p>Saldo consultado después: {run.balancesAfter?.map(b => `${b.asset}: ${b.free}`).join(' · ') ?? 'Pendiente de consultar'}</p><button className="secondary-button" disabled={busy || status.busy} onClick={() => void act(async () => { await post('/api/execution/reconcile', { id: run.id }) })}>Consultar órdenes y saldos en Binance</button><a href={`/api/execution`} target="_blank" rel="noreferrer"> Ver detalle JSON</a></details>)}
  </section>
}
