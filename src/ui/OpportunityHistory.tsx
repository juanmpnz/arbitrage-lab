import { useEffect, useRef, useState } from 'react'
import { Clock3, RefreshCw } from 'lucide-react'
import type { Opportunity } from '../core/arbitrage'
import { readApi } from '../core/account'
export type HistoryConfig = { startAsset: string; amount: number; feeMode: 'account' | 'manual'; feeBps: number; slippageBps: number; minNetBps: number }
type Snapshot = { capturedAt: number; config: HistoryConfig; opportunities: Opportunity[] }
type Record = Opportunity & { id: string; firstSeenAt: number; lastSeenAt: number; active: boolean; durationMs: number; observations: number; bestNetBps: number; bestOutput: number; config: HistoryConfig }
const format = (value: number) => value.toLocaleString('es-ES', { maximumFractionDigits: 8 })
export default function OpportunityHistory({ opportunities, config, live }: { opportunities: Opportunity[]; config: HistoryConfig; live: boolean }) {
  const sessionId = useRef(crypto.randomUUID())
  const queue = useRef<Snapshot[]>([])
  const busy = useRef(false)
  const mounted = useRef(false)
  const [records, setRecords] = useState<Record[]>([])
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const refresh = async () => {
    try { const data = await readApi<{ records: Record[] }>('/api/opportunities'); if (mounted.current) { setRecords(data.records); setError('') } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'No se pudo leer el historial') }
  }
  useEffect(() => {
    if (!Number.isFinite(config.amount) || config.amount <= 0 || !Number.isFinite(config.minNetBps) || config.minNetBps < 0) return
    queue.current.push({ capturedAt: Date.now(), config, opportunities: live ? opportunities.filter(item => item.netBps > 0).slice(0, 50) : [] })
    if (queue.current.length > 20) { queue.current.shift(); setTruncated(true) }
  }, [opportunities, config.startAsset, config.amount, config.feeMode, config.feeBps, config.slippageBps, config.minNetBps, live])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const flush = async () => {
      if (busy.current || !queue.current.length) return
      busy.current = true
      const batch = queue.current.splice(0, 20).filter(snapshot => Date.now() - snapshot.capturedAt < 55_000)
      if (!batch.length) { busy.current = false; return }
      try {
        const response = await fetch('/api/opportunities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId.current, snapshots: batch }), signal: AbortSignal.timeout(10_000) })
        if (!response.ok) {
          let message = `No se pudo guardar el historial (HTTP ${response.status}). Reinicia el backend actualizado.`
          try { const data = await response.json() as { error?: string }; if (data.error) message = data.error } catch { /* Proxy may return HTML. */ }
          throw new Error(message)
        }
        await refresh()
      } catch (cause) {
        queue.current = [...batch, ...queue.current].slice(-20)
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'No se pudo guardar el historial')
      } finally { busy.current = false }
    }
    const timer = window.setInterval(() => { void flush() }, 2000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [])
  return <section className="panel paper-panel">
    <div className="panel-heading"><div><div className="panel-title"><span className="title-icon amber"><Clock3 size={16}/></span><h2>Historial de oportunidades</h2><span className="count-pill">{records.length}</span></div><p>Señales observadas · estimaciones, sin operaciones ni ganancias realizadas</p></div><button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={14}/> Actualizar</button></div>
    {error && <p className="account-error" role="alert">{error}</p>}
    {truncated && <p className="account-error" role="status">El backend estuvo sin responder: algunas observaciones pendientes pudieron perderse.</p>}
    <div className="paper-trades-wrap"><table className="paper-trades"><thead><tr><th>PRIMERA DETECCIÓN</th><th>RUTA</th><th>MODO / COSTOS</th><th>IMPORTE</th><th>MEJOR NETO EST.</th><th>DURACIÓN OBSERVADA</th><th>ESTADO</th></tr></thead><tbody>{records.slice(0, 50).map(record => <tr key={record.id}><td>{new Date(record.firstSeenAt).toLocaleString('es-ES')}</td><td>{record.route.join(' → ')}</td><td>{record.config.feeMode === 'account' ? 'Cuenta · último cálculo' : 'Manual'}<br/>{record.legFeeBps ? record.legFeeBps.map(value => `${(value / 100).toFixed(4)} %`).join(' / ') : 'Tarifas no registradas'}<br/>Deslizamiento: {record.config.slippageBps} pb/tramo</td><td>{format(record.input)} {record.route[0]}</td><td>+{format(record.bestOutput - record.input)} {record.route[0]}<br/>+{(record.bestNetBps / 100).toFixed(4)} %</td><td>{(record.durationMs / 1000).toFixed(1)} s · {record.observations} observaciones</td><td>{record.active ? 'Observada recientemente' : 'Ya no observada'}</td></tr>)}{!records.length && <tr><td colSpan={7} className="paper-empty">Todavía no hay señales guardadas. Las nuevas oportunidades se registran automáticamente con el backend encendido.</td></tr>}</tbody></table></div>
    <div className="paper-note"><span>Se agrupa la misma ruta e importe mientras siga apareciendo. Se conservan las últimas 1.000 detecciones; se muestran 50. El laboratorio captura hasta 50 rutas por evaluación mientras la pestaña está abierta. El automático registra sus señales desde el servidor. La duración corresponde a observaciones, no garantiza que hubiera tiempo para ejecutar.</span></div>
  </section>
}
