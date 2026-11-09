import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import api from './api';
import QRScanner from './components/QRScanner';
import './history.css';
import './parking.css';

function Login({ onLogin }) {
  const [email,setEmail] = useState('admin@example.com');
  const [password,setPassword] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try { const r = await api.post('/auth/login',{email,password}); localStorage.setItem('parking_token',r.data.token); onLogin(r.data.user); }
    catch (err) { setError(err.response?.data?.error || 'Login failed'); }
    finally { setBusy(false); }
  }
  return <main className="login-wrap"><form className="panel login" onSubmit={submit}>
    <div className="brand-icon">P</div><h1>Parking Management</h1><p className="muted">Sign in to continue</p>
    <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required /></label>
    <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required /></label>
    {error && <p className="error">{error}</p>}<button disabled={busy}>{busy?'Signing in…':'Sign in'}</button>
    <p className="muted small">Seed the Super Admin using <code>npm run seed:admin</code> in backend.</p>
  </form></main>;
}

function Dashboard() {
  const [data,setData] = useState(null);
  const [error,setError] = useState('');
  useEffect(()=>{ api.get('/dashboard').then(r=>setData(r.data)).catch(e=>setError(e.response?.data?.error || 'Failed to load')); },[]);
  const stats = data ? [
    ['Currently parked',data.active,'car-front'],['Entries today',data.entriesToday,'log-in'],
    ['Exits today',data.exitsToday,'log-out'],['Revenue today',`₹${data.revenueToday}`,'indian-rupee']
  ] : [];
  return <><h1>Dashboard</h1><p className="muted">Parking activity overview</p>{error&&<p className="error">{error}</p>}
    <div className="stats">{stats.map(([label,value])=><div className="panel stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="panel"><h2>Quick start</h2><p>Register a vehicle, then use Parking Desk to record entry and exit with QR or manual lookup.</p><Link className="button-link" to="/vehicles">Register vehicle</Link> <Link className="button-link secondary" to="/parking">Open parking desk</Link></div>
  </>;
}

function VehicleQRCode({ vehicle, onClose }) {
  const [imageUrl, setImageUrl] = useState('');

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(vehicle.qr_token, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
      .then(url => { if (active) setImageUrl(url); });
    return () => { active = false; };
  }, [vehicle.qr_token]);

  function download() {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = `${vehicle.vehicle_number}-parking-qr.png`;
    link.click();
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="qr-card" role="dialog" aria-modal="true" aria-labelledby="qr-title" onMouseDown={e=>e.stopPropagation()}>
      <div className="qr-card-heading"><div><p className="eyebrow">PARKING PASS</p><h2 id="qr-title">{vehicle.vehicle_number}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close QR code">×</button></div>
      {imageUrl?<img className="qr-image" src={imageUrl} alt={`QR code for ${vehicle.vehicle_number}`} />:<div className="qr-loading">Generating QR code…</div>}
      <p className="muted small qr-help">Scan this code at the parking desk for vehicle entry or exit.</p>
      <code className="qr-token">{vehicle.qr_token}</code>
      <div className="actions qr-actions"><button className="outline" onClick={onClose}>Close</button><button disabled={!imageUrl} onClick={download}>Download QR</button></div>
    </section>
  </div>;
}

const emptyVehicleForm = { vehicleNumber:'', phoneNumber:'', vehicleType:'car' };

function VehicleFormModal({ vehicle, onClose, onSaved }) {
  const [form,setForm] = useState(vehicle ? { vehicleNumber:vehicle.vehicle_number, phoneNumber:vehicle.phone_number, vehicleType:vehicle.vehicle_type } : emptyVehicleForm);
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  const editing = Boolean(vehicle);
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      if (editing) await api.patch(`/vehicles/${vehicle.id}`, form); else await api.post('/vehicles', form);
      onSaved(editing ? 'Vehicle updated.' : 'Vehicle registered.');
    } catch (e) { setError(e.response?.data?.error || `Could not ${editing ? 'update' : 'register'} vehicle`); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="form-modal" role="dialog" aria-modal="true" aria-labelledby="vehicle-modal-title" onMouseDown={e=>e.stopPropagation()}>
      <div className="modal-heading"><h2 id="vehicle-modal-title">{editing ? 'Edit vehicle' : 'Register vehicle'}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog">×</button></div>
      <form onSubmit={submit}><label>Vehicle number<input value={form.vehicleNumber} onChange={e=>setForm({...form,vehicleNumber:e.target.value})} placeholder="TS09AB1234" required autoFocus /></label>
        <label>Phone number<input value={form.phoneNumber} onChange={e=>setForm({...form,phoneNumber:e.target.value})} placeholder="+919876543210" required /></label>
        <label>Vehicle type<select value={form.vehicleType} onChange={e=>setForm({...form,vehicleType:e.target.value})}><option value="bike">Bike</option><option value="car">Car</option><option value="van">Van</option><option value="truck">Truck</option></select></label>
        {error&&<p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="outline" onClick={onClose}>Cancel</button><button disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Register vehicle'}</button></div>
      </form>
    </section>
  </div>;
}

function DeleteVehicleModal({ vehicle, onClose, onDeleted }) {
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  async function remove() {
    setError(''); setBusy(true);
    try { await api.delete(`/vehicles/${vehicle.id}`); onDeleted(); }
    catch (e) { setError(e.response?.data?.error || 'Could not delete vehicle'); setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title" onMouseDown={e=>e.stopPropagation()}>
      <h2 id="delete-modal-title">Delete vehicle?</h2><p>Delete <b>{vehicle.vehicle_number}</b>? This cannot be undone.</p>
      {error&&<p className="error">{error}</p>}<div className="modal-actions"><button className="outline" onClick={onClose}>Cancel</button><button className="danger" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete vehicle'}</button></div>
    </section>
  </div>;
}

function Vehicles() {
  const [vehicles,setVehicles] = useState([]); const [total,setTotal] = useState(0);
  const [page,setPage] = useState(1); const [registeredDate,setRegisteredDate] = useState(''); const pageSize = 10;
  const [error,setError] = useState(''); const [message,setMessage] = useState('');
  const [selectedVehicle,setSelectedVehicle] = useState(null); const [formVehicle,setFormVehicle] = useState(undefined); const [deleteVehicle,setDeleteVehicle] = useState(null);
  const load = useCallback(async () => {
    setError('');
    try { const r = await api.get('/vehicles', { params:{ page, limit:pageSize, date:registeredDate || undefined } }); setVehicles(r.data.vehicles); setTotal(r.data.total); }
    catch(e) { setError(e.response?.data?.error || 'Could not load vehicles'); }
  },[page,registeredDate]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{setPage(1);},[registeredDate]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  function saved(text) { setFormVehicle(undefined); setMessage(text); load(); }
  function deleted() { setDeleteVehicle(null); setMessage('Vehicle deleted.'); if (vehicles.length === 1 && page > 1) setPage(page - 1); else load(); }
  return <><div className="page-heading"><div><h1>Vehicles</h1><p className="muted">Manage registered vehicles and their parking passes.</p></div><button onClick={()=>setFormVehicle(null)}>+ Register vehicle</button></div>
    {error&&<p className="error">{error}</p>}{message&&<p className="success">{message}</p>}
    <div className="panel vehicle-panel"><div className="list-toolbar"><div><h2>Registered vehicles</h2><p className="muted small">{total} vehicle{total===1?'':'s'} found</p></div><div className="date-filter"><label>Registration date<input type="date" value={registeredDate} onChange={e=>setRegisteredDate(e.target.value)} /></label><button className="outline compact-button" onClick={()=>setRegisteredDate('')}>Clear</button></div></div>
      {vehicles.length===0?<p className="muted">No vehicles registered for this date.</p>:<div className="table-wrap"><table><thead><tr><th>Vehicle</th><th>Type</th><th>Phone</th><th>Registered</th><th>Actions</th></tr></thead><tbody>{vehicles.map(v=><tr key={v.id}><td>{v.vehicle_number}</td><td><span className="pill">{v.vehicle_type}</span></td><td>{v.phone_number}</td><td>{new Date(v.created_at).toLocaleDateString()}</td><td><div className="row-actions"><button className="qr-button" onClick={()=>setSelectedVehicle(v)}>Show QR</button><button className="outline compact-button" onClick={()=>setFormVehicle(v)}>Edit</button><button className="danger outline compact-button" onClick={()=>setDeleteVehicle(v)}>Delete</button></div></td></tr>)}</tbody></table></div>}
      <div className="pagination"><span className="muted small">Page {Math.min(page,totalPages)} of {totalPages}</span><div><button className="outline compact-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous</button><button className="outline compact-button" disabled={page>=totalPages} onClick={()=>setPage(page+1)}>Next</button></div></div>
    </div>
    {formVehicle!==undefined&&<VehicleFormModal vehicle={formVehicle} onClose={()=>setFormVehicle(undefined)} onSaved={saved} />}{deleteVehicle&&<DeleteVehicleModal vehicle={deleteVehicle} onClose={()=>setDeleteVehicle(null)} onDeleted={deleted} />}{selectedVehicle&&<VehicleQRCode vehicle={selectedVehicle} onClose={()=>setSelectedVehicle(null)} />}
  </>;
}

function Parking() {
  const [query,setQuery] = useState('');
  const [result,setResult] = useState(null);
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');
  const [showScanner,setShowScanner] = useState(false);
  const [busy,setBusy] = useState(false);
  const [payMethod,setPayMethod] = useState('cash');
  const [phonePeOrder,setPhonePeOrder] = useState('');
  const [active,setActive] = useState([]);
  const [parkedDate,setParkedDate] = useState(() => {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    return today.toISOString().slice(0,10);
  });
  const loadActive = useCallback(()=>api.get('/parking/active').then(r=>setActive(r.data.sessions)).catch(()=>{}),[]);
  useEffect(()=>{loadActive();},[loadActive]);
  async function act(action, value=query) {
    setBusy(true);setError('');setMessage('');setResult(null);
    try {
      const r = await api.post(`/parking/${action}`, action==='entry' ? {vehicleNumber:value} : {vehicleNumber:value});
      setResult(r.data);setMessage(r.data.message);setQuery(value);loadActive();
    } catch(e) { setError(e.response?.data?.error || 'Request failed'); }
    finally {setBusy(false);}
  }
  async function lookupExit() { await act('exit',query); }
  async function complete() {
    if (!result?.session?.id) return;
    setBusy(true);setError('');
    try { const r=await api.post(`/parking/${result.session.id}/complete-exit`,{paymentMethod:payMethod});setMessage(r.data.message);setResult(null);setQuery('');loadActive(); }
    catch(e){setError(e.response?.data?.error || 'Payment failed');}
    finally{setBusy(false);}
  }
  async function startPhonePeCheckout() {
    if (!result?.session?.id) return;
    setBusy(true); setError('');
    try {
      const response = await api.post('/payments/phonepe/create', { sessionId: result.session.id });
      setPhonePeOrder(response.data.orderId);
      window.location.assign(response.data.checkoutUrl);
    } catch (e) { setError(e.response?.data?.error || 'Could not start PhonePe checkout'); setBusy(false); }
  }
  const onScan = useCallback(async (decoded) => {
    const value = decoded.trim();
    setQuery(value);setShowScanner(false);setBusy(true);setError('');setMessage('QR scanned. Checking vehicle status…');
    try {
      const lookup = await api.get('/vehicles/lookup', { params: { query: value } });
      await act(lookup.data.activeSession ? 'exit' : 'entry', value);
    } catch (e) {
      setBusy(false);setMessage('');setError(e.response?.data?.error || 'Could not find the scanned vehicle');
    }
  }, [act]);
  const activeForDate = active.filter(session => {
    if (!parkedDate) return true;
    const entry = new Date(session.entry_time);
    const localDate = `${entry.getFullYear()}-${String(entry.getMonth()+1).padStart(2,'0')}-${String(entry.getDate()).padStart(2,'0')}`;
    return localDate === parkedDate;
  });
  const typeCounts = activeForDate.reduce((counts, session) => {
    const type = session.vehicle_type || 'other';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  return <><h1>Parking Desk</h1><p className="muted">Scan a QR code for automatic entry or exit, or use the manual controls below.</p>
    <div className="two-col"><div className="panel"><h2>Vehicle scan / lookup</h2>
      <label>Manual vehicle number or QR token<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="TS09AB1234 or QR token" /></label>
      <div className="actions"><button disabled={!query.trim()||busy} onClick={()=>act('entry')}>Manual Vehicle IN</button><button className="secondary" disabled={!query.trim()||busy} onClick={lookupExit}>Manual Vehicle OUT</button><button className="outline" disabled={busy} onClick={()=>setShowScanner(v=>!v)}>{showScanner?'Close scanner':'Scan QR automatically'}</button></div>
      {showScanner&&<QRScanner onScan={onScan}/>}
      {message&&<p className="success">{message}</p>}{error&&<p className="error">{error}</p>}
      {result?.session&&<div className="result"><h3>Parking fee / session</h3><p>Vehicle: <b>{result.vehicle?.vehicle_number}</b></p><p>Entry: {new Date(result.session.entry_time).toLocaleString()}</p>{result.session.exit_time&&<><p>Exit: {new Date(result.session.exit_time).toLocaleString()}</p><p>Duration: {result.session.duration_minutes} minutes</p><h2>Amount: ₹{result.session.amount}</h2><div className="payment-choices"><button className="phonepe-button" disabled={busy} onClick={startPhonePeCheckout}>Pay securely with PhonePe</button><span className="muted small">You will be redirected to PhonePe and returned once payment is complete.</span></div><label>Record offline payment<select value={payMethod} onChange={e=>setPayMethod(e.target.value)}><option value="cash">Cash received</option><option value="demo">Demo payment (not real)</option></select></label><button disabled={busy} onClick={complete}>Confirm {payMethod==='cash'?'cash':'demo'} payment and finish</button>{phonePeOrder&&<p className="muted small">PhonePe order: {phonePeOrder}</p>}</>}</div>}
    </div><div className="panel"><div className="parked-heading"><div><h2>Currently parked ({activeForDate.length})</h2><p className="muted small">{parkedDate?'Vehicles entered on the selected date.':'Vehicles from all entry dates.'}</p></div><div className="parked-date-filter"><label>Entry date<input type="date" value={parkedDate} onChange={e=>setParkedDate(e.target.value)} /></label><button className="outline compact-button" onClick={()=>setParkedDate('')}>All dates</button></div></div>{Object.keys(typeCounts).length>0&&<div className="type-counts">{Object.entries(typeCounts).sort(([a],[b])=>a.localeCompare(b)).map(([type,count])=><span className="type-count" key={type}><b>{count}</b> {type}{count===1?'':'s'}</span>)}</div>}{activeForDate.length===0?<p className="muted">No active sessions for this date.</p>:<div className="table-wrap"><table><thead><tr><th>Vehicle</th><th>Type</th><th>Entry time</th><th>Status</th></tr></thead><tbody>{activeForDate.map(s=><tr key={s.session_id}><td>{s.vehicle_number}</td><td>{s.vehicle_type}</td><td>{new Date(s.entry_time).toLocaleString()}</td><td><span className="pill">{s.status}</span></td></tr>)}</tbody></table></div>}</div></div>
  </>;
}

function History() {
  const [rows,setRows]=useState([]);const [error,setError]=useState('');
  const [filters,setFilters]=useState({vehicle:'',entry:'',exit:'',minutes:'',amount:'',payment:'',status:''});
  const [entryFrom,setEntryFrom]=useState('');const [entryTo,setEntryTo]=useState('');
  const [sort,setSort]=useState({key:'entry',direction:'desc'});const [page,setPage]=useState(1);const pageSize=10;
  const columns=[['vehicle','Vehicle'],['entry','Entry'],['exit','Exit'],['minutes','Minutes'],['amount','Amount'],['payment','Payment'],['status','Status']];
  useEffect(()=>{api.get('/parking/history').then(r=>setRows(r.data.sessions)).catch(e=>setError(e.response?.data?.error||'Could not load history'));},[]);
  useEffect(()=>{setPage(1);},[filters,entryFrom,entryTo,sort]);
  const paymentText=r=>`${r.payment_status||'—'}${r.payment_method?` (${r.payment_method})`:''}`;
  const displayValue=(r,key)=>({vehicle:r.vehicle_number||'',entry:r.entry_time?new Date(r.entry_time).toLocaleString():'',exit:r.exit_time?new Date(r.exit_time).toLocaleString():'',minutes:r.duration_minutes??'',amount:r.amount??'',payment:paymentText(r),status:r.status||''}[key]);
  const sortValue=(r,key)=>key==='entry'?new Date(r.entry_time).getTime():key==='exit'?(r.exit_time?new Date(r.exit_time).getTime():0):['minutes','amount'].includes(key)?Number(displayValue(r,key)||0):String(displayValue(r,key)).toLowerCase();
  const filtered=rows.filter(r=>{
    const timestamp=new Date(r.entry_time).getTime();
    return (!entryFrom||timestamp>=new Date(`${entryFrom}T00:00:00`).getTime())&&(!entryTo||timestamp<=new Date(`${entryTo}T23:59:59.999`).getTime())&&columns.every(([key])=>String(displayValue(r,key)).toLowerCase().includes(filters[key].toLowerCase()));
  }).sort((a,b)=>{const left=sortValue(a,sort.key),right=sortValue(b,sort.key);const result=typeof left==='number'?left-right:left.localeCompare(right);return sort.direction==='asc'?result:-result;});
  const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));const activePage=Math.min(page,totalPages);const visibleRows=filtered.slice((activePage-1)*pageSize,activePage*pageSize);
  function toggleSort(key){setSort(current=>current.key===key?{key,direction:current.direction==='asc'?'desc':'asc'}:{key,direction:'asc'});}
  function clearFilters(){setFilters({vehicle:'',entry:'',exit:'',minutes:'',amount:'',payment:'',status:''});setEntryFrom('');setEntryTo('');}
  return <><h1>Parking history</h1>{error&&<p className="error">{error}</p>}<div className="panel"><div className="history-toolbar"><div><h2>Parking sessions</h2><p className="muted small">{filtered.length} matching record{filtered.length===1?'':'s'}</p></div><div className="date-filters"><label>Entry from<input type="date" value={entryFrom} onChange={e=>setEntryFrom(e.target.value)} /></label><label>Entry to<input type="date" value={entryTo} onChange={e=>setEntryTo(e.target.value)} /></label><button className="outline compact-button" onClick={clearFilters}>Clear filters</button></div></div><div className="table-wrap"><table><thead><tr>{columns.map(([key,label])=><th key={key}><button className="sort-button" onClick={()=>toggleSort(key)}>{label}<span>{sort.key===key?(sort.direction==='asc'?' ▲':' ▼'):' ↕'}</span></button></th>)}</tr><tr className="filter-row">{columns.map(([key,label])=><th key={key}><input aria-label={`Filter ${label}`} value={filters[key]} onChange={e=>setFilters({...filters,[key]:e.target.value})} placeholder={`Filter ${label.toLowerCase()}`} /></th>)}</tr></thead><tbody>{visibleRows.length===0?<tr><td className="empty-history" colSpan={columns.length}>No parking sessions match these filters.</td></tr>:visibleRows.map(r=><tr key={r.session_id}><td>{r.vehicle_number}</td><td>{r.entry_time?new Date(r.entry_time).toLocaleString():'—'}</td><td>{r.exit_time?new Date(r.exit_time).toLocaleString():'—'}</td><td>{r.duration_minutes??'—'}</td><td>{r.amount==null?'—':`₹${r.amount}`}</td><td>{paymentText(r)}</td><td>{r.status}</td></tr>)}</tbody></table></div><div className="pagination"><span className="muted small">Page {activePage} of {totalPages}</span><div><button className="outline compact-button" disabled={activePage===1} onClick={()=>setPage(activePage-1)}>Previous</button><button className="outline compact-button" disabled={activePage===totalPages} onClick={()=>setPage(activePage+1)}>Next</button></div></div></div></>;
}

function PhonePeSettings() {
  const [form,setForm] = useState({ enabled:false, environment:'sandbox', clientId:'', clientVersion:'1', clientSecret:'', webhookKeyId:'', webhookSecret:'' });
  const [message,setMessage] = useState(''); const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  useEffect(()=>{api.get('/admin/payment-settings/phonepe').then(r=>{ const s=r.data.settings; setForm(current=>({...current, enabled:s.enabled, environment:s.environment, clientId:s.clientId||'', clientVersion:s.clientVersion||'1', webhookKeyId:s.webhookKeyId||''})); }).catch(e=>setError(e.response?.data?.error||'Could not load PhonePe settings'));},[]);
  async function submit(e) { e.preventDefault(); setBusy(true); setError(''); setMessage(''); try { const r=await api.put('/admin/payment-settings/phonepe',form); setForm(current=>({...current,clientSecret:'',webhookSecret:''})); setMessage(r.data.settings.configured?'PhonePe gateway configuration saved.':'Configuration saved but PhonePe is disabled.'); } catch(e) { setError(e.response?.data?.error||'Could not save PhonePe settings'); } finally { setBusy(false); } }
  return <><h1>Payment settings</h1><p className="muted">Only Super Admins can configure the PhonePe payment gateway.</p><form className="panel gateway-form" onSubmit={submit}><div className="gateway-heading"><div><h2>PhonePe Standard Checkout</h2><p className="muted small">Secrets are encrypted before being stored and are never returned to the browser.</p></div><label className="toggle-label"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})} /> Enable PhonePe</label></div><div className="settings-grid"><label>Environment<select value={form.environment} onChange={e=>setForm({...form,environment:e.target.value})}><option value="sandbox">Sandbox / UAT</option><option value="production">Production</option></select></label><label>Client ID<input value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})} required /></label><label>Client version<input value={form.clientVersion} onChange={e=>setForm({...form,clientVersion:e.target.value})} required /></label><label>Client secret<input type="password" value={form.clientSecret} onChange={e=>setForm({...form,clientSecret:e.target.value})} placeholder="Enter to save or replace" /></label><label>Webhook key ID<input value={form.webhookKeyId} onChange={e=>setForm({...form,webhookKeyId:e.target.value})} placeholder="x-phonepe-checksum-key-id" /></label><label>Webhook secret<input type="password" value={form.webhookSecret} onChange={e=>setForm({...form,webhookSecret:e.target.value})} placeholder="Enter to save or replace" /></label></div><p className="muted small">Configure the PhonePe webhook URL as <code>/api/payments/phonepe/webhook</code> and subscribe to checkout order completed and failed events.</p>{error&&<p className="error">{error}</p>}{message&&<p className="success">{message}</p>}<button disabled={busy}>{busy?'Saving…':'Save PhonePe settings'}</button></form></>;
}

function PaymentResult() {
  const location = useLocation(); const [state,setState] = useState({ loading:true, error:'', success:false, status:'' });
  const orderId = new URLSearchParams(location.search).get('orderId');
  useEffect(()=>{ if(!orderId){setState({loading:false,error:'Missing PhonePe order ID',success:false,status:''});return;} api.get(`/payments/phonepe/${encodeURIComponent(orderId)}/verify`).then(r=>setState({loading:false,error:'',success:r.data.success,status:r.data.state||''})).catch(e=>setState({loading:false,error:e.response?.data?.error||'Could not verify PhonePe payment',success:false,status:''})); },[orderId]);
  return <div className="payment-result panel"><h1>{state.loading?'Verifying payment…':state.success?'Payment complete':'Payment not complete'}</h1>{state.loading?<p className="muted">Confirming the payment securely with PhonePe.</p>:state.success?<><p className="success">Your parking payment was verified. A confirmation will be sent by SMS or WhatsApp when notifications are configured.</p><Link className="button-link" to="/parking">Return to Parking Desk</Link></>:<><p className="error">{state.error||`PhonePe reports this payment as ${state.status||'pending'}.`}</p><Link className="button-link" to="/parking">Return to Parking Desk</Link></>}</div>;
}

function Users() {
  const [users,setUsers]=useState([]);const [form,setForm]=useState({name:'',email:'',password:'',role:'operator'});const [message,setMessage]=useState('');const [error,setError]=useState('');
  const load=useCallback(()=>api.get('/admin/users').then(r=>setUsers(r.data.users)).catch(e=>setError(e.response?.data?.error||'Could not load users')),[]);
  useEffect(()=>{load();},[load]);
  async function submit(e){e.preventDefault();setError('');setMessage('');try{await api.post('/admin/users',form);setMessage('User created');setForm({name:'',email:'',password:'',role:'operator'});load();}catch(e){setError(e.response?.data?.error||'Could not create user');}}
  return <><h1>User management</h1><div className="two-col"><form className="panel" onSubmit={submit}><h2>Create user</h2>
    <label>Name<input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required /></label>
    <label>Email<input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} required /></label>
    <label>Temporary password (10+ characters)<input type="password" minLength="10" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} required /></label>
    <label>Role<select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="operator">Operator</option><option value="super_admin">Super Admin</option></select></label>
    {message&&<p className="success">{message}</p>}{error&&<p className="error">{error}</p>}<button>Create user</button></form>
    <div className="panel"><h2>Users</h2><div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>{users.map(u=><tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td></tr>)}</tbody></table></div></div></div></>;
}

export default function App() {
  const [user,setUser]=useState(null);const navigate=useNavigate();
  useEffect(()=>{const token=localStorage.getItem('parking_token');if(token)api.get('/auth/me').then(r=>setUser(r.data.user)).catch(()=>localStorage.removeItem('parking_token'));},[]);
  function logout(){localStorage.removeItem('parking_token');setUser(null);navigate('/login');}
  if(!user) return <Routes><Route path="*" element={<Login onLogin={setUser}/>}/></Routes>;
  return <div className="layout"><aside className="sidebar"><div className="brand"><span className="brand-icon small-icon">P</span><span>ParkPilot</span></div><p className="side-label">WORKSPACE</p><nav><Link to="/">Dashboard</Link><Link to="/vehicles">Vehicles</Link><Link to="/parking">Parking desk</Link><Link to="/history">Parking history</Link>{user.role==='super_admin'&&<><Link to="/users">User management</Link><Link to="/payment-settings">Payment settings</Link></>}</nav><div className="side-bottom"><b>{user.name}</b><span className="muted small">{user.role.replace('_',' ')}</span><button className="outline" onClick={logout}>Sign out</button></div></aside>
    <main className="main"><header><span>Parking Operations</span><span className="pill">{user.role.replace('_',' ')}</span></header><div className="content"><Routes><Route path="/" element={<Dashboard/>}/><Route path="/vehicles" element={<Vehicles/>}/><Route path="/parking" element={<Parking/>}/><Route path="/history" element={<History/>}/><Route path="/users" element={user.role==='super_admin'?<Users/>:<Navigate to="/"/>}/><Route path="/payment-settings" element={user.role==='super_admin'?<PhonePeSettings/>:<Navigate to="/"/>}/><Route path="/payment-result" element={<PaymentResult/>}/><Route path="*" element={<Navigate to="/"/>}/></Routes></div></main></div>;
}
