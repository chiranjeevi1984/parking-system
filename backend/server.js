require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const pool = require('./db');
const { authenticate, allowRoles } = require('./auth');
const calculateFee = require('./fees');
const { sendEntryAlert, sendExitAlert } = require('./notifications');
const { encrypt, getSettings, getConfiguredSettings, publicSettings, phonepeRequest, verifyWebhook } = require('./phonepe');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));

async function notifySafely(send) {
  try {
    return await send();
  } catch (error) {
    console.error('Parking alert could not be sent:', error.message);
    return { sent: false, reason: 'Notification delivery failed' };
  }
}

async function finalizePhonePePayment(orderId) {
  const paymentResult = await pool.query(`SELECT p.*, s.id AS session_id, s.amount AS session_amount, s.status AS session_status,
    v.vehicle_number, v.phone_number FROM parking_payments p JOIN parking_sessions s ON s.id=p.session_id
    JOIN vehicles v ON v.id=s.vehicle_id WHERE p.gateway_order_id=$1 AND p.payment_method='phonepe'`, [orderId]);
  if (!paymentResult.rowCount) throw new Error('PhonePe order not found');
  const payment = paymentResult.rows[0];
  if (payment.status === 'success') return { success: true, payment };
  const settings = await getConfiguredSettings();
  const status = await phonepeRequest(settings, `/checkout/v2/order/${encodeURIComponent(orderId)}/status?details=false`, { method: 'GET' });
  const amountPaise = Math.round(Number(payment.session_amount) * 100);
  if (status.state !== 'COMPLETED' || Number(status.amount) !== amountPaise) {
    if (status.state === 'FAILED') await pool.query(`UPDATE parking_payments SET status='failed', gateway_response=$2, updated_at=NOW() WHERE id=$1`, [payment.id, status]);
    return { success: false, state: status.state || 'PENDING' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`UPDATE parking_payments SET status='success', paid_at=NOW(), payment_reference=$2,
      gateway_response=$3, updated_at=NOW() WHERE id=$1 AND status <> 'success' RETURNING *`, [payment.id, status.paymentDetails?.[0]?.transactionId || orderId, status]);
    await client.query(`UPDATE parking_sessions SET status='completed' WHERE id=$1 AND status='awaiting_payment'`, [payment.session_id]);
    await client.query('COMMIT');
    if (updated.rowCount) await notifySafely(() => sendExitAlert(payment, { amount: payment.session_amount }, 'success'));
    return { success: true, payment: updated.rows[0] || payment };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
  catch { res.status(503).json({ status: 'error', database: 'unavailable' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT id, name, email, password_hash, role FROM users WHERE email=$1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

app.get('/api/dashboard', authenticate, async (_req, res) => {
  try {
    const active = await pool.query(`SELECT COUNT(*)::int AS count FROM parking_sessions WHERE status IN ('parked','awaiting_payment')`);
    const entries = await pool.query(`SELECT COUNT(*)::int AS count FROM parking_sessions WHERE entry_time >= CURRENT_DATE`);
    const exits = await pool.query(`SELECT COUNT(*)::int AS count FROM parking_sessions WHERE exit_time >= CURRENT_DATE`);
    const revenue = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total FROM parking_payments WHERE status='success' AND paid_at >= CURRENT_DATE`);
    res.json({ active: active.rows[0].count, entriesToday: entries.rows[0].count, exitsToday: exits.rows[0].count, revenueToday: revenue.rows[0].total });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load dashboard' }); }
});

app.get('/api/vehicles', authenticate, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const registeredDate = String(req.query.date || '').trim();
    if (registeredDate && !/^\d{4}-\d{2}-\d{2}$/.test(registeredDate)) {
      return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
    }
    const values = [];
    const conditions = [];
    if (registeredDate) {
      values.push(registeredDate);
      conditions.push(`v.created_at::date = $${values.length}::date`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM vehicles v ${where}`, values);
    values.push(limit, (page - 1) * limit);
    const r = await pool.query(`SELECT v.id, v.vehicle_number, v.phone_number, v.vehicle_type, v.qr_token, v.created_at
      FROM vehicles v ${where} ORDER BY v.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    res.json({ vehicles: r.rows, total: count.rows[0].count, page, limit });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load vehicles' }); }
});

app.patch('/api/vehicles/:id', authenticate, async (req, res) => {
  try {
    const vehicleNumber = String(req.body.vehicleNumber || '').trim().toUpperCase();
    const phoneNumber = String(req.body.phoneNumber || '').trim();
    const vehicleType = String(req.body.vehicleType || '').toLowerCase();
    if (!/^[A-Z0-9 -]{4,20}$/.test(vehicleNumber)) return res.status(400).json({ error: 'Enter a valid vehicle number' });
    if (!/^[+0-9 ()-]{7,20}$/.test(phoneNumber)) return res.status(400).json({ error: 'Enter a valid phone number' });
    if (!['bike','car','van','truck'].includes(vehicleType)) return res.status(400).json({ error: 'Invalid vehicle type' });
    const r = await pool.query(
      `UPDATE vehicles SET vehicle_number=$1, phone_number=$2, vehicle_type=$3 WHERE id=$4
       RETURNING id, vehicle_number, phone_number, vehicle_type, qr_token, created_at`,
      [vehicleNumber, phoneNumber, vehicleType, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ vehicle: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Vehicle number or phone number already exists' });
    console.error(e); res.status(500).json({ error: 'Could not update vehicle' });
  }
});

app.delete('/api/vehicles/:id', authenticate, async (req, res) => {
  try {
    const sessions = await pool.query('SELECT 1 FROM parking_sessions WHERE vehicle_id=$1 LIMIT 1', [req.params.id]);
    if (sessions.rowCount) return res.status(409).json({ error: 'Vehicles with parking history cannot be deleted' });
    const r = await pool.query('DELETE FROM vehicles WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ message: 'Vehicle deleted' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not delete vehicle' }); }
});

app.post('/api/vehicles', authenticate, async (req, res) => {
  try {
    const vehicleNumber = String(req.body.vehicleNumber || '').trim().toUpperCase();
    const phoneNumber = String(req.body.phoneNumber || '').trim();
    const vehicleType = String(req.body.vehicleType || '').toLowerCase();
    if (!/^[A-Z0-9 -]{4,20}$/.test(vehicleNumber)) return res.status(400).json({ error: 'Enter a valid vehicle number' });
    if (!/^[+0-9 ()-]{7,20}$/.test(phoneNumber)) return res.status(400).json({ error: 'Enter a valid phone number' });
    if (!['bike','car','van','truck'].includes(vehicleType)) return res.status(400).json({ error: 'Invalid vehicle type' });
    const r = await pool.query(
      `INSERT INTO vehicles (vehicle_number, phone_number, vehicle_type) VALUES ($1,$2,$3)
       RETURNING id, vehicle_number, phone_number, vehicle_type, qr_token, created_at`,
      [vehicleNumber, phoneNumber, vehicleType]);
    res.status(201).json({ vehicle: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Vehicle number or phone number already exists' });
    console.error(e); res.status(500).json({ error: 'Could not register vehicle' });
  }
});

app.get('/api/vehicles/lookup', authenticate, async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Provide a vehicle number or QR token' });
    const r = await pool.query(
      `SELECT id, vehicle_number, phone_number, vehicle_type, qr_token FROM vehicles
       WHERE UPPER(vehicle_number)=UPPER($1) OR qr_token::text=$1 LIMIT 1`, [query]);
    if (!r.rowCount) return res.status(404).json({ error: 'Vehicle not found' });
    const active = await pool.query(
      `SELECT id, entry_time, status FROM parking_sessions
       WHERE vehicle_id=$1 AND status IN ('parked','awaiting_payment')`, [r.rows[0].id]);
    res.json({ vehicle: r.rows[0], activeSession: active.rows[0] || null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Vehicle lookup failed' }); }
});

app.post('/api/parking/entry', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const query = String(req.body.vehicleNumber || req.body.qrToken || '').trim();
    if (!query) return res.status(400).json({ error: 'Scan QR or enter vehicle number' });
    await client.query('BEGIN');
    const v = await client.query(
      `SELECT id, vehicle_number, vehicle_type, phone_number FROM vehicles
       WHERE UPPER(vehicle_number)=UPPER($1) OR qr_token::text=$1 FOR UPDATE`, [query]);
    if (!v.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vehicle not registered' }); }
    const existing = await client.query(
      `SELECT id FROM parking_sessions WHERE vehicle_id=$1 AND status IN ('parked','awaiting_payment')`,
      [v.rows[0].id]);
    if (existing.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Vehicle already has an active parking session' }); }
    const session = await client.query(
      `INSERT INTO parking_sessions (vehicle_id, entry_operator_id) VALUES ($1,$2)
       RETURNING id, vehicle_id, entry_time, status`, [v.rows[0].id, req.user.id]);
    await client.query('COMMIT');
    const notification = await notifySafely(() => sendEntryAlert(v.rows[0], session.rows[0]));
    res.status(201).json({ message: 'Vehicle entry recorded', vehicle: v.rows[0], session: session.rows[0], notification });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Could not record entry' }); }
  finally { client.release(); }
});

app.post('/api/parking/exit', authenticate, async (req, res) => {
  try {
    const query = String(req.body.vehicleNumber || req.body.qrToken || '').trim();
    if (!query) return res.status(400).json({ error: 'Scan QR or enter vehicle number' });
    const v = await pool.query(
      `SELECT id, vehicle_number, vehicle_type FROM vehicles
       WHERE UPPER(vehicle_number)=UPPER($1) OR qr_token::text=$1 LIMIT 1`, [query]);
    if (!v.rowCount) return res.status(404).json({ error: 'Vehicle not registered' });
    const s = await pool.query(
      `SELECT id, entry_time, status FROM parking_sessions
       WHERE vehicle_id=$1 AND status IN ('parked','awaiting_payment')`, [v.rows[0].id]);
    if (!s.rowCount) return res.status(409).json({ error: 'No active parking session for this vehicle' });
    const rate = await pool.query('SELECT first_hour_rate, additional_hour_rate FROM parking_rates WHERE vehicle_type=$1', [v.rows[0].vehicle_type]);
    if (!rate.rowCount) return res.status(500).json({ error: 'Parking rate not configured' });
    const exitTime = new Date();
    const fee = calculateFee(s.rows[0].entry_time, exitTime, rate.rows[0].first_hour_rate, rate.rows[0].additional_hour_rate);
    const updated = await pool.query(
      `UPDATE parking_sessions SET exit_time=$1, duration_minutes=$2, amount=$3, status='awaiting_payment', exit_operator_id=$4
       WHERE id=$5 AND status='parked'
       RETURNING id, entry_time, exit_time, duration_minutes, amount, status`,
      [exitTime, fee.durationMinutes, fee.amount, req.user.id, s.rows[0].id]);
    if (!updated.rowCount && s.rows[0].status !== 'awaiting_payment') return res.status(409).json({ error: 'Session changed; please scan again' });
    const session = updated.rows[0] || (await pool.query('SELECT id, entry_time, exit_time, duration_minutes, amount, status FROM parking_sessions WHERE id=$1', [s.rows[0].id])).rows[0];
    res.json({ message: 'Exit fee calculated. Confirm payment to complete exit.', vehicle: v.rows[0], session });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || 'Could not calculate exit fee' }); }
});

app.post('/api/parking/:sessionId/complete-exit', authenticate, async (req, res) => {
  const method = String(req.body.paymentMethod || '');
  if (!['cash','demo'].includes(method)) return res.status(400).json({ error: 'This starter only supports cash or demo payment. PhonePe must be verified server-side before enabling it.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(
      `SELECT s.*, v.vehicle_number, v.phone_number
       FROM parking_sessions s JOIN vehicles v ON v.id=s.vehicle_id
       WHERE s.id=$1 FOR UPDATE`,
      [req.params.sessionId]);
    if (!s.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Parking session not found' }); }
    const session = s.rows[0];
    if (session.status !== 'awaiting_payment' || session.amount == null) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Session is not awaiting payment' });
    }
    const payment = await client.query(
      `INSERT INTO parking_payments (session_id, amount, payment_method, payment_reference, status, paid_at)
       VALUES ($1,$2,$3,$4,'success',NOW()) RETURNING id, amount, payment_method, status, paid_at`,
      [session.id, session.amount, method, `${method}-${randomUUID()}`]);
    await client.query(`UPDATE parking_sessions SET status='completed' WHERE id=$1`, [session.id]);
    await client.query('COMMIT');
    const notification = await notifySafely(() => sendExitAlert(session, session, payment.rows[0].status));
    res.json({ message: 'Payment recorded and parking session completed', payment: payment.rows[0], notification });
  } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') return res.status(409).json({ error: 'Payment already recorded' }); console.error(e); res.status(500).json({ error: 'Could not complete exit' }); }
  finally { client.release(); }
});

app.get('/api/parking/active', authenticate, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const entryDate = String(req.query.date || '').trim();
    if (entryDate && !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
    const values = []; const filters = [`s.status IN ('parked','awaiting_payment')`];
    if (entryDate) { values.push(entryDate); filters.push(`s.entry_time::date = $${values.length}::date`); }
    const where = `WHERE ${filters.join(' AND ')}`;
    const total = await pool.query(`SELECT COUNT(*)::int AS count FROM parking_sessions s ${where}`, values);
    values.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT s.id AS session_id, v.vehicle_number, v.vehicle_type, v.phone_number, s.entry_time, s.status
       FROM parking_sessions s JOIN vehicles v ON v.id=s.vehicle_id
       ${where} ORDER BY s.entry_time ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    res.json({ sessions: r.rows, total: total.rows[0].count, page, limit });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load active parking' }); }
});

app.get('/api/parking/history', authenticate, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id AS session_id, v.vehicle_number, v.vehicle_type, s.entry_time, s.exit_time,
        s.duration_minutes, s.amount, s.status, p.status AS payment_status, p.payment_method
       FROM parking_sessions s JOIN vehicles v ON v.id=s.vehicle_id
       LEFT JOIN parking_payments p ON p.session_id=s.id
       ORDER BY s.id DESC LIMIT 300`);
    res.json({ sessions: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load history' }); }
});

app.get('/api/admin/users', authenticate, allowRoles('super_admin'), async (_req, res) => {
  const r = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY id DESC');
  res.json({ users: r.rows });
});

app.post('/api/admin/users', authenticate, allowRoles('super_admin'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'operator');
    if (!name || !email.includes('@') || password.length < 10 || !['super_admin','operator'].includes(role)) {
      return res.status(400).json({ error: 'Provide name, valid email, password (at least 10 characters), and role' });
    }
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query('INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role',
      [name,email,hash,role]);
    res.status(201).json({ user: r.rows[0] });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' }); console.error(e); res.status(500).json({ error: 'Could not create user' }); }
});

app.get('/api/admin/payment-settings/phonepe', authenticate, allowRoles('super_admin'), async (_req, res) => {
  try { res.json({ settings: publicSettings(await getSettings()) || { configured: false, enabled: false, environment: 'sandbox', clientVersion: '1' } }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load PhonePe settings' }); }
});

app.put('/api/admin/payment-settings/phonepe', authenticate, allowRoles('super_admin'), async (req, res) => {
  try {
    const current = await getSettings(); const enabled = Boolean(req.body.enabled);
    const environment = String(req.body.environment || 'sandbox'); const clientId = String(req.body.clientId || '').trim();
    const clientVersion = String(req.body.clientVersion || '1').trim(); const clientSecret = String(req.body.clientSecret || '').trim();
    const webhookKeyId = String(req.body.webhookKeyId || '').trim(); const webhookSecret = String(req.body.webhookSecret || '').trim();
    if (!['sandbox','production'].includes(environment) || !clientId || !clientVersion) return res.status(400).json({ error: 'Provide environment, Client ID, and Client Version' });
    if (!clientSecret && !current?.client_secret_encrypted) return res.status(400).json({ error: 'Provide the PhonePe Client Secret' });
    if (enabled && (!webhookKeyId || (!webhookSecret && !current?.webhook_secret_encrypted))) return res.status(400).json({ error: 'An enabled gateway requires PhonePe webhook key ID and secret' });
    const result = await pool.query(`INSERT INTO payment_gateway_settings (provider, enabled, environment, client_id, client_version, client_secret_encrypted, webhook_key_id, webhook_secret_encrypted, updated_by)
      VALUES ('phonepe',$1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (provider) DO UPDATE SET enabled=EXCLUDED.enabled, environment=EXCLUDED.environment, client_id=EXCLUDED.client_id,
      client_version=EXCLUDED.client_version, client_secret_encrypted=COALESCE(EXCLUDED.client_secret_encrypted,payment_gateway_settings.client_secret_encrypted),
      webhook_key_id=EXCLUDED.webhook_key_id, webhook_secret_encrypted=COALESCE(EXCLUDED.webhook_secret_encrypted,payment_gateway_settings.webhook_secret_encrypted), updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING *`,
      [enabled, environment, clientId, clientVersion, clientSecret ? encrypt(clientSecret) : null, webhookKeyId || null, webhookSecret ? encrypt(webhookSecret) : null, req.user.id]);
    res.json({ settings: publicSettings(result.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || 'Could not save PhonePe settings' }); }
});

app.post('/api/payments/phonepe/create', authenticate, async (req, res) => {
  try {
    const sessionId = Number(req.body.sessionId); if (!Number.isSafeInteger(sessionId)) return res.status(400).json({ error: 'A valid parking session is required' });
    const settings = await getConfiguredSettings();
    const session = await pool.query(`SELECT s.id, s.amount, s.status, v.vehicle_number FROM parking_sessions s JOIN vehicles v ON v.id=s.vehicle_id WHERE s.id=$1`, [sessionId]);
    if (!session.rowCount || session.rows[0].status !== 'awaiting_payment' || session.rows[0].amount == null) return res.status(409).json({ error: 'Parking session is not awaiting payment' });
    const existing = await pool.query(`SELECT gateway_order_id FROM parking_payments WHERE session_id=$1 AND payment_method='phonepe' AND status='pending'`, [sessionId]);
    if (existing.rowCount) return res.status(409).json({ error: 'A PhonePe payment is already pending for this session', orderId: existing.rows[0].gateway_order_id });
    const orderId = `PP${sessionId}${Date.now()}${randomUUID().replace(/-/g,'').slice(0,8)}`;
    const redirectUrl = `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/payment-result?orderId=${encodeURIComponent(orderId)}`;
    await pool.query(`INSERT INTO parking_payments (session_id, amount, payment_method, payment_reference, gateway_order_id, status) VALUES ($1,$2,'phonepe',$3,$3,'pending')`, [sessionId, session.rows[0].amount, orderId]);
    try {
      const response = await phonepeRequest(settings, '/checkout/v2/pay', { method: 'POST', body: JSON.stringify({ merchantOrderId: orderId, amount: Math.round(Number(session.rows[0].amount) * 100), expireAfter: 1200, paymentFlow: { type: 'PG_CHECKOUT', message: `Parking payment for ${session.rows[0].vehicle_number}`, merchantUrls: { redirectUrl } }, metaInfo: { udf1: String(sessionId) } }) });
      await pool.query(`UPDATE parking_payments SET gateway_response=$2, updated_at=NOW() WHERE gateway_order_id=$1`, [orderId, response]);
      const checkoutUrl = response.redirectUrl || response.data?.redirectUrl;
      if (!checkoutUrl) throw new Error('PhonePe did not return a checkout URL');
      res.status(201).json({ orderId, checkoutUrl });
    } catch (error) { await pool.query(`UPDATE parking_payments SET status='failed', updated_at=NOW() WHERE gateway_order_id=$1`, [orderId]); throw error; }
  } catch (e) { console.error(e); res.status(502).json({ error: e.message || 'Could not create PhonePe checkout' }); }
});

app.get('/api/payments/phonepe/:orderId/verify', authenticate, async (req, res) => {
  try { const result = await finalizePhonePePayment(req.params.orderId); res.json(result); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message || 'Could not verify PhonePe payment' }); }
});

app.post('/api/payments/phonepe/webhook', async (req, res) => {
  try {
    const settings = await getSettings(); const signature = req.get('phonepe-checksum-signature'); const keyId = req.get('x-phonepe-checksum-key-id');
    if (!verifyWebhook(settings, req.rawBody || Buffer.from(''), signature, keyId)) return res.status(401).json({ error: 'Invalid webhook signature' });
    const orderId = req.body?.payload?.merchantOrderId || req.body?.merchantOrderId || req.body?.data?.merchantOrderId;
    if (orderId) await finalizePhonePePayment(orderId);
    res.sendStatus(204);
  } catch (e) { console.error('PhonePe webhook failed:', e); res.sendStatus(500); }
});

const port = Number(process.env.PORT || 5000);
app.listen(port, () => console.log(`Parking API listening on http://localhost:${port}`));
