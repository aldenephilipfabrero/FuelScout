import './config.js'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql')
const schema = await readFile(schemaPath, 'utf8')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

try {
  await pool.query(schema)
  console.log('PostgreSQL schema applied successfully.')
} catch (error) {
  console.error('Could not apply the PostgreSQL schema. Check DATABASE_URL and database permissions.')
  throw error
} finally {
  await pool.end()
}
