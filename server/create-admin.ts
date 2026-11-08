import './config.js'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'

const name = process.env.ADMIN_NAME?.trim()
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const password = process.env.ADMIN_PASSWORD

if (!name || !email || !/^\S+@\S+\.\S+$/.test(email) || !password || password.length < 12) {
  throw new Error('Set ADMIN_NAME, a valid ADMIN_EMAIL, and an ADMIN_PASSWORD with at least 12 characters.')
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

try {
  const passwordHash = await bcrypt.hash(password, 12)
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE
     SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'admin'
     RETURNING id, name, email`,
    [name, email, passwordHash],
  )
  console.log(`Administrator account ready for ${rows[0].email} (id ${rows[0].id}).`)
} catch (error) {
  console.error('Could not create the administrator account. Apply the database schema and check DATABASE_URL.')
  throw error
} finally {
  await pool.end()
}
