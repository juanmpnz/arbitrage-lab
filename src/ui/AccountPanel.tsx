import { useState } from 'react'
import { RefreshCw, ShieldCheck, WalletCards } from 'lucide-react'

import type { Account, Commission } from '../core/account'
import { readApi as read } from '../core/account'

const rate = (value: string) => `${(Number(value) * 100).toFixed(4)} %`

export default function AccountPanel({ onAccount }: { onAccount: (account: Account | null) => void }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [commission, setCommission] = useState<Commission | null>(null)
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const connect = async () => {
    setBusy(true); setError('')
    try {
      const health = await read<{ configured: boolean }>('/api/health')
      if (!health.configured) throw new Error('Completa BINANCE_API_KEY y BINANCE_API_SECRET en .env y reinicia el backend.')
      const next = await read<Account>('/api/account'); setAccount(next); onAccount(next)
    } catch (cause) { setAccount(null); onAccount(null); setError(cause instanceof Error ? cause.message : 'Error de conexión.') }
    finally { setBusy(false) }
  }
  const queryCommission = async () => {
    setBusy(true); setError(''); setCommission(null)
    try { setCommission(await read<Commission>(`/api/commission?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudieron consultar las comisiones.') }
    finally { setBusy(false) }
  }
  return <section className="panel paper-panel">
    <div className="panel-heading"><div><div className="panel-title"><span className="title-icon blue"><WalletCards size={16}/></span><h2>Cuenta Binance</h2><span className="paper-badge">CONSULTA DE SALDO{account ? ` · ${account.environment.toUpperCase()}` : ''}</span></div><p>Saldo Spot y comisiones consultados desde tu backend local</p></div><button className="secondary-button" disabled={busy} onClick={() => void connect()}><RefreshCw size={14}/>{busy ? 'Consultando…' : account ? 'Actualizar saldo' : 'Conectar cuenta'}</button></div>
    {error && <p className="account-error" role="alert">{error}</p>}
    {!account ? <div className="paper-note"><ShieldCheck size={14}/><span>Configura las claves en el .env local y arranca el backend. La cuenta real y el saldo del paper trader son independientes.</span></div> : <>
      <div className="paper-trades-wrap"><table className="paper-trades"><thead><tr><th>ACTIVO</th><th>DISPONIBLE</th><th>BLOQUEADO</th></tr></thead><tbody>{account.balances.map(balance => <tr key={balance.asset}><td>{balance.asset}</td><td>{balance.free}</td><td>{balance.locked}</td></tr>)}{!account.balances.length && <tr><td colSpan={3} className="paper-empty">La cuenta Spot no tiene saldos positivos.</td></tr>}</tbody></table></div>
      <form className="commission-form" onSubmit={event => { event.preventDefault(); void queryCommission() }}><label htmlFor="commission-symbol">Comisiones del par</label><input id="commission-symbol" value={symbol} onChange={event => setSymbol(event.target.value)} maxLength={30}/><button className="secondary-button" disabled={busy}>Consultar</button></form>
      {commission && <div className="paper-note"><ShieldCheck size={14}/><span><b>{commission.symbol}</b> · Estándar: maker {rate(commission.standardCommission.maker)}, taker {rate(commission.standardCommission.taker)}, comprador {rate(commission.standardCommission.buyer)}, vendedor {rate(commission.standardCommission.seller)}.<br/>Especial: taker {rate(commission.specialCommission.taker)}, comprador {rate(commission.specialCommission.buyer)}, vendedor {rate(commission.specialCommission.seller)}. Impuestos: taker {rate(commission.taxCommission.taker)}, comprador {rate(commission.taxCommission.buyer)}, vendedor {rate(commission.taxCommission.seller)}.<br/>Descuento {commission.discount.discountAsset}: {commission.discount.enabledForAccount && commission.discount.enabledForSymbol ? `${rate(String(1 - Number(commission.discount.discount)))} de reducción (se paga ${rate(commission.discount.discount)}), sujeto a saldo y pago en ese activo` : 'no habilitado'}. El scanner consulta automáticamente las tarifas de cada ruta cuando activas la evaluación con cuenta.</span></div>}
      <div className="panel-footer"><span>Última consulta: {new Date(account.fetchedAt).toLocaleTimeString()}</span><span>{account.accountType} · órdenes desde el panel Ejecución Spot</span></div>
    </>}
  </section>
}
