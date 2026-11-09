require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./db');

async function main() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD in .env');
  }
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'super_admin')
     ON CONFLICT (email) DO NOTHING`,
    [ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), passwordHash]
  );
  console.log(`Super Admin seed checked for ${ADMIN_EMAIL}`);
  await pool.end();
}
main().catch(async err => { console.error(err.message); await pool.end(); process.exit(1); });
