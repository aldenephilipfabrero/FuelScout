import './config.js'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  await client.query('ALTER TABLE stations DROP CONSTRAINT IF EXISTS stations_name_key')
  await client.query('ALTER TABLE stations ADD COLUMN IF NOT EXISTS source_ref TEXT')
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS stations_source_ref_uidx ON stations (source_ref)')
  await client.query('BEGIN')
  const stations = [
    { sourceRef: 'sample:shell-edsa-guadalupe', name: 'Shell EDSA Guadalupe', brand: 'Shell', address: 'EDSA corner P. Burgos St, Makati', latitude: 14.5668, longitude: 121.0457, prices: [['Unleaded', 63.4], ['Diesel', 58.8], ['Premium', 66.1]] },
    { sourceRef: 'sample:petron-buendia', name: 'Petron Buendia', brand: 'Petron', address: 'Gil Puyat Avenue, Makati', latitude: 14.5548, longitude: 121.0172, prices: [['Unleaded', 62.9], ['Diesel', 57.9]] },
    { sourceRef: 'sample:caltex-circuit-makati', name: 'Caltex Circuit Makati', brand: 'Caltex', address: 'J.P. Rizal Ext, Makati', latitude: 14.5653, longitude: 121.0401, prices: [['Unleaded', 64.2], ['Diesel', 58.1], ['Premium', 67.3]] },
    { sourceRef: 'sample:unioil-pioneer', name: 'Unioil Pioneer', brand: 'Unioil', address: 'Pioneer Street, Mandaluyong', latitude: 14.5691, longitude: 121.0561, prices: [['Unleaded', 61.8], ['Diesel', 57.2]] },
  ] as const
  for (const station of stations) {
    const result = await client.query(
      `INSERT INTO stations (source_ref, name, brand, address, latitude, longitude) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source_ref) DO UPDATE SET name = EXCLUDED.name, brand = EXCLUDED.brand, address = EXCLUDED.address, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude RETURNING id`,
      [station.sourceRef, station.name, station.brand, station.address, station.latitude, station.longitude],
    )
    for (const [fuelType, price] of station.prices) {
      await client.query('INSERT INTO fuel_prices (station_id, fuel_type, price, source) VALUES ($1, $2, $3, \'demo\') ON CONFLICT (station_id, fuel_type) DO UPDATE SET price = EXCLUDED.price, source = \'demo\', updated_at = now()', [result.rows[0].id, fuelType, price])
    }
  }
  await client.query('COMMIT')
  console.log(`Seeded ${stations.length} sample stations.`)
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}