const crypto = require('crypto');
const pool = require('./db');

const tokenCache = new Map();
const urls = {
  sandbox: {
    token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
    base: 'https://api-preprod.phonepe.com/apis/pg-sandbox'
  },
  production: {
    token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
    base: 'https://api.phonepe.com/apis/pg'
  }
};

function key() {
  const value = process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('PAYMENT_SETTINGS_ENCRYPTION_KEY must be a 64-character hexadecimal key');
  return Buffer.from(value, 'hex');
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

function decrypt(value) {
  const [iv, tag, data] = String(value || '').split('.').map(part => Buffer.from(part, 'base64'));
  if (!iv || !tag || !data) throw new Error('Stored PhonePe secret is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function publicSettings(row) {
  return row && { configured: Boolean(row.enabled && row.client_id && row.client_secret_encrypted), enabled: row.enabled, environment: row.environment, clientId: row.client_id, clientVersion: row.client_version, webhookKeyId: row.webhook_key_id, hasClientSecret: Boolean(row.client_secret_encrypted), hasWebhookSecret: Boolean(row.webhook_secret_encrypted), updatedAt: row.updated_at };
}

async function getSettings() {
  const result = await pool.query('SELECT * FROM payment_gateway_settings WHERE provider=$1', ['phonepe']);
  return result.rows[0] || null;
}

async function getConfiguredSettings() {
  const settings = await getSettings();
  if (!settings?.enabled || !settings.client_id || !settings.client_secret_encrypted) throw new Error('PhonePe is not configured or enabled by a Super Admin');
  return { ...settings, clientSecret: decrypt(settings.client_secret_encrypted) };
}

async function accessToken(settings) {
  const cached = tokenCache.get(settings.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const form = new URLSearchParams({ client_id: settings.client_id, client_version: settings.client_version, client_secret: settings.clientSecret, grant_type: 'client_credentials' });
  const response = await fetch(urls[settings.environment].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(payload.message || payload.error || 'PhonePe authorization failed');
  const expiresAt = Number(payload.expires_at || 0) * 1000 || Date.now() + 10 * 60_000;
  tokenCache.set(settings.id, { token: payload.access_token, expiresAt });
  return payload.access_token;
}

async function phonepeRequest(settings, path, options = {}) {
  const token = await accessToken(settings);
  const response = await fetch(`${urls[settings.environment].base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `O-Bearer ${token}`, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || 'PhonePe request failed');
  return payload;
}

function verifyWebhook(settings, rawBody, signature, keyId) {
  if (!settings?.webhook_secret_encrypted || !signature || (settings.webhook_key_id && keyId !== settings.webhook_key_id)) return false;
  const expected = crypto.createHmac('sha256', decrypt(settings.webhook_secret_encrypted)).update(rawBody).digest('hex');
  const received = Buffer.from(String(signature));
  return received.length === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(expected), received);
}

module.exports = { encrypt, getSettings, getConfiguredSettings, publicSettings, phonepeRequest, verifyWebhook };
