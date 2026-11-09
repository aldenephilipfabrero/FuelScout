import './config.js'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createRequire } from 'node:module'
import { Pool, type PoolClient } from 'pg'
import { load } from 'cheerio'

const requireFromHere = createRequire(import.meta.url)
const pdfParse = requireFromHere('pdf-parse/lib/pdf-parse.js') as typeof import('pdf-parse')

const app = express()
const port = Number(process.env.PORT || process.env.API_PORT || 3001)
const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) throw new Error('Set JWT_SECRET to a random value of at least 32 characters.')

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || true }))
app.use(express.json({ limit: '32kb' }))

type Role = 'user' | 'station' | 'admin'
type VehicleCategory = 'Motorcycle' | 'Car / Sedan' | 'SUV' | 'Pickup / Truck' | 'Van' | 'Other'
const vehicleCategories: VehicleCategory[] = ['Motorcycle', 'Car / Sedan', 'SUV', 'Pickup / Truck', 'Van', 'Other']
type VehicleRecord = {
  category: VehicleCategory
  epaId: number | null
  make: string
  model: string
  type: string | null
  variant: string
  version: string
  year: number
  fuelType: string
  fuelEconomyKmL: number
  economySource: 'EPA' | 'Typical estimate'
}
type VehicleRow = {
  vehicle_category: VehicleCategory | null
  vehicle_epa_id: number | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_type: string | null
  vehicle_variant: string | null
  vehicle_version: string | null
  vehicle_year: number | null
  vehicle_fuel_type: string | null
  vehicle_economy_km_l: string | number | null
}
type EpaMenuItem = { label: string; value: string }
type EpaMenuResponse = { menuItems?: { menuItem?: Array<{ text?: string; value?: string }> } }
type NhtsaResponse<T> = { Results?: T[] }
type NhtsaMake = { MakeName: string; VehicleTypeName: string }
type NhtsaModel = { Make_Name: string; Model_Name: string; VehicleTypeName: string }
type AuthInfo = { id: number; role: Role; stationId: number | null; name: string; email: string }
type AuthedRequest = Request & { auth?: AuthInfo }
type StationRow = { id: number; name: string; brand: string; address: string; latitude: number; longitude: number; distance_km: number; source_ref?: string | null }
type NationalFuelAdjustment = { fuelType: string; direction: 'increase' | 'rollback'; low: number; high: number; ytdNetChange: number | null }
type NationalFuelAdvisory = { title: string; asOf: string; effectivePeriod: string; sourceUrl: string; sourcePage: string; fetchedAt: string; adjustments: NationalFuelAdjustment[] }

let fuelPricingSchema: Promise<void> | null = null
let nationalFuelAdvisoryCache: { value: NationalFuelAdvisory; cachedAt: number } | null = null
const epaXmlCache = new Map<string, { body: string; expiresAt: number }>()
const nhtsaJsonCache = new Map<string, { body: unknown; expiresAt: number }>()

function mapVehicle(row: VehicleRow): VehicleRecord | null {
  if (!row.vehicle_category || !row.vehicle_make || !row.vehicle_model || !row.vehicle_variant ||
      !row.vehicle_version || !row.vehicle_year || !row.vehicle_fuel_type || !row.vehicle_economy_km_l) return null
  return {
    category: row.vehicle_category,
    epaId: row.vehicle_epa_id ? Number(row.vehicle_epa_id) : null,
    make: row.vehicle_make,
    model: row.vehicle_model,
    type: row.vehicle_type,
    variant: row.vehicle_variant,
    version: row.vehicle_version,
    year: Number(row.vehicle_year),
    fuelType: row.vehicle_fuel_type,
    fuelEconomyKmL: Number(row.vehicle_economy_km_l),
    economySource: row.vehicle_epa_id ? 'EPA' : 'Typical estimate',
  }
}

async function getEpaXml(path: string, query: Record<string, string> = {}) {
  const url = new URL(`https://www.fueleconomy.gov/ws/rest/${path}`)
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
  const key = url.toString()
  let body = epaXmlCache.get(key)
  if (!body || body.expiresAt < Date.now()) {
    let response: globalThis.Response
    try { response = await fetch(url, { signal: AbortSignal.timeout(10000) }) }
    catch {
      throw Object.assign(new Error('FuelEconomy.gov is unavailable right now. Try loading the vehicle catalog again.'), { statusCode: 502 })
    }
    if (!response.ok) throw Object.assign(new Error(`FuelEconomy.gov returned HTTP ${response.status}.`), { statusCode: 502 })
    const text = await response.text()
    body = { body: text, expiresAt: Date.now() + 30 * 60 * 1000 }
    if (epaXmlCache.size >= 250) {
      for (const [cachedKey, cachedValue] of epaXmlCache) {
        if (cachedValue.expiresAt < Date.now() || epaXmlCache.size >= 200) epaXmlCache.delete(cachedKey)
      }
    }
    epaXmlCache.set(key, body)
  }
  return load(body.body, { xmlMode: true })
}

async function getNhtsaResults<T>(path: string): Promise<T[]> {
  const cached = nhtsaJsonCache.get(path)
  if (cached && cached.expiresAt > Date.now()) {
    return (cached.body as NhtsaResponse<T>).Results ?? []
  }

  const url = new URL(path, 'https://vpic.nhtsa.dot.gov/api/vehicles/')
  url.searchParams.set('format', 'json')
  let response: globalThis.Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  } catch {
    throw Object.assign(new Error('The motorcycle catalog is unavailable right now. Try loading it again.'), { statusCode: 502 })
  }
  if (!response.ok) {
    throw Object.assign(new Error(`The motorcycle catalog returned HTTP ${response.status}.`), { statusCode: 502 })
  }
  const body = await response.json() as NhtsaResponse<T>
  if (!Array.isArray(body.Results)) {
    throw Object.assign(new Error('The motorcycle catalog returned an invalid response.'), { statusCode: 502 })
  }
  if (nhtsaJsonCache.size >= 250) {
    for (const [cachedPath, cachedValue] of nhtsaJsonCache) {
      if (cachedValue.expiresAt < Date.now() || nhtsaJsonCache.size >= 200) nhtsaJsonCache.delete(cachedPath)
    }
  }
  nhtsaJsonCache.set(path, { body, expiresAt: Date.now() + 30 * 60 * 1000 })
  return body.Results
}

function validMotorcycleYear(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1981 && Number(value) <= new Date().getFullYear() + 1
}

async function getNhtsaMotorcycleModels(year: number, make: string): Promise<NhtsaModel[]> {
  const path = `GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}/vehicletype/motorcycle`
  const results = await getNhtsaResults<NhtsaModel>(path)
  return results.filter((item) =>
    typeof item.Make_Name === 'string' &&
    typeof item.Model_Name === 'string' &&
    item.VehicleTypeName?.toLowerCase() === 'motorcycle',
  )
}

function epaMenuItems($: ReturnType<typeof load>): EpaMenuItem[] {
  return $('menuItem').toArray().flatMap((element) => {
    const text = $(element).find('text').first().text().trim()
    const value = $(element).find('value').first().text().trim()
    return text && value ? [{ label: text, value }] : []
  })
}

function validVehicleYear(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1984 && Number(value) <= new Date().getFullYear() + 1
}

function vehicleField(value: unknown, maximumLength = 100): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximumLength
}

async function getEpaVehicle(id: number): Promise<Omit<VehicleRecord, 'variant' | 'economySource'>> {
  const $ = await getEpaXml(`vehicle/${id}`)
  const get = (name: string) => $(`vehicle > ${name}`).first().text().trim()
  const year = Number(get('year'))
  const make = get('make')
  const model = get('model')
  const type = get('VClass')
  const mpg = Number(get('comb08'))
  const fuelType = get('fuelType1')
  const fuelType2 = get('fuelType2')
  const plugInHybrid = get('phevBlended') === 'true'
  if (!validVehicleYear(year) || !make || !model || !type) {
    throw Object.assign(new Error('FuelEconomy.gov does not have a complete record for that vehicle.'), { statusCode: 404 })
  }
  if (!Number.isFinite(mpg) || mpg <= 0 || !fuelType || fuelType === 'Electricity' || fuelType2 || plugInHybrid) {
    throw Object.assign(new Error('This EPA record does not provide a liquid-fuel economy suitable for a liters estimate.'), { statusCode: 422 })
  }
  const transmission = get('trany')
  const cylinders = get('cylinders')
  const displacement = get('displ')
  const engine = [cylinders ? `${cylinders} cyl` : '', displacement && Number(displacement) > 0 ? `${displacement} L` : ''].filter(Boolean).join(', ')
  const version = [transmission, engine].filter(Boolean).join(', ')
  return {
    category: 'Car / Sedan',
    epaId: id,
    make,
    model,
    type,
    version: version || 'EPA configuration',
    year,
    fuelType,
    fuelEconomyKmL: Number((mpg * 0.425143707).toFixed(2)),
  }
}

function matchNumber(text: string, pattern: RegExp) {
  const result = text.match(pattern)
  return result ? Number(result[1]) : null
}

async function getNationalFuelAdvisory(): Promise<NationalFuelAdvisory> {
  if (nationalFuelAdvisoryCache && Date.now() - nationalFuelAdvisoryCache.cachedAt < 6 * 60 * 60 * 1000) {
    return nationalFuelAdvisoryCache.value
  }

  const sourcePage = 'https://doe.gov.ph/data-and-prices/liquid-fuels/oil-monitor'
  const pageResponse = await fetch(sourcePage, { signal: AbortSignal.timeout(15000) })
  if (!pageResponse.ok) throw new Error(`DOE Oil Monitor returned ${pageResponse.status}.`)
  const $ = load(await pageResponse.text())
  const attachment = $('figure.attachment-preview--pdf a[href]').first()
  const sourceUrl = attachment.attr('href')
  const title = attachment.text().trim()
  if (!sourceUrl || !title.toLowerCase().includes('oil monitor')) throw new Error('DOE Oil Monitor did not expose a latest PDF attachment.')

  const pdfResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(20000) })
  if (!pdfResponse.ok) throw new Error(`DOE Oil Monitor PDF returned ${pdfResponse.status}.`)
  const pdf = await pdfParse(Buffer.from(await pdfResponse.arrayBuffer()))
  const text = pdf.text.replace(/\s+/g, ' ')
  const asOf = text.match(/OIL MONITOR\s+As of\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)?.[1]
  const effectivePeriod = text.match(/For the week\s+([^.]+)/i)?.[1]?.trim()
    ?? text.match(/effective\s+(\d{1,2}\s+through\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)?.[1]
  const overallDirection = text.match(/Domestic pump prices\s+(increased|decreased)\s+by/i)?.[1]?.toLowerCase()
  const gasolineRange = text.match(/Php\s*([\d.]+)\s*\/L\s*to\s*Php\s*([\d.]+)\s*L?\s*\/?\s*for gasoline/i)
  const keroseneChange = matchNumber(text, /Php\s*([\d.]+)\s*\/L\s*for kerosene/i)
  const dieselText = text.match(/pump prices for diesel\s+(increased|decreased)\s+by\s+Php\s*([\d.]+)\s*\/L/i)
  const gasolineYtd = matchNumber(text, /P\s*([\d.]+)\s*\/liter\s*for gasoline/i)
  const dieselYtd = matchNumber(text, /P\s*([\d.]+)\s*\/liter\s*for diesel/i)
  const keroseneYtd = matchNumber(text, /P\s*([\d.]+)\s*\/liter\s*for kerosene/i)

  if (!asOf || !effectivePeriod || !overallDirection || !gasolineRange || !keroseneChange || !dieselText) {
    throw new Error('Could not parse the latest DOE Oil Monitor values; no national figures were published.')
  }

  const direction = (value: string): 'increase' | 'rollback' => value === 'decreased' ? 'rollback' : 'increase'
  const value: NationalFuelAdvisory = {
    title,
    asOf,
    effectivePeriod,
    sourceUrl,
    sourcePage,
    fetchedAt: new Date().toISOString(),
    adjustments: [
      { fuelType: 'Gasoline', direction: direction(overallDirection), low: Number(gasolineRange[1]), high: Number(gasolineRange[2]), ytdNetChange: gasolineYtd },
      { fuelType: 'Diesel', direction: direction(dieselText[1].toLowerCase()), low: Number(dieselText[2]), high: Number(dieselText[2]), ytdNetChange: dieselYtd },
      { fuelType: 'Kerosene', direction: direction(overallDirection), low: keroseneChange, high: keroseneChange, ytdNetChange: keroseneYtd },
    ],
  }
  nationalFuelAdvisoryCache = { value, cachedAt: Date.now() }
  return value
}

function ensureFuelPricingSchema() {
  if (!fuelPricingSchema) {
    fuelPricingSchema = pool.query(`
      CREATE TABLE IF NOT EXISTS fuel_price_reports (
        id BIGSERIAL PRIMARY KEY,
        station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
        price NUMERIC(8, 2) NOT NULL CHECK (price > 0 AND price <= 1000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(async () => {
      await pool.query('CREATE INDEX IF NOT EXISTS fuel_price_reports_latest_idx ON fuel_price_reports (station_id, fuel_type, created_at DESC)')
      await pool.query("ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'station'")
      await pool.query(`UPDATE fuel_prices fp SET source = 'demo' FROM stations s WHERE fp.station_id = s.id AND s.source_ref LIKE 'sample:%'`)
      await pool.query(`
        UPDATE fuel_prices fp SET source = 'demo' FROM stations s
        WHERE fp.station_id = s.id AND s.source_ref IS NULL AND (
          (s.name = 'Shell EDSA Guadalupe' AND s.latitude = 14.5668 AND s.longitude = 121.0457) OR
          (s.name = 'Petron Buendia' AND s.latitude = 14.5548 AND s.longitude = 121.0172) OR
          (s.name = 'Caltex Circuit Makati' AND s.latitude = 14.5653 AND s.longitude = 121.0401) OR
          (s.name = 'Unioil Pioneer' AND s.latitude = 14.5691 AND s.longitude = 121.0561)
        )
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS fuel_price_history (
          id BIGSERIAL PRIMARY KEY,
          station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
          user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
          fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
          previous_price NUMERIC(8, 2),
          new_price NUMERIC(8, 2) NOT NULL CHECK (new_price > 0 AND new_price <= 1000),
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await pool.query('CREATE INDEX IF NOT EXISTS fuel_price_history_latest_idx ON fuel_price_history (station_id, fuel_type, recorded_at DESC)')
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_fuel_expenses (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
          liters NUMERIC(8, 2) NOT NULL CHECK (liters > 0 AND liters <= 10000),
          price_per_liter NUMERIC(8, 2) NOT NULL CHECK (price_per_liter > 0 AND price_per_liter <= 1000),
          station_name TEXT,
          purchased_at DATE NOT NULL DEFAULT CURRENT_DATE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await pool.query('CREATE INDEX IF NOT EXISTS user_fuel_expenses_latest_idx ON user_fuel_expenses (user_id, purchased_at DESC, id DESC)')
      await pool.query(`
        CREATE TABLE IF NOT EXISTS in_app_notifications (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN ('price_increase', 'price_rollback')),
          station_id BIGINT REFERENCES stations(id) ON DELETE SET NULL,
          station_name TEXT NOT NULL,
          fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
          previous_price NUMERIC(8, 2) NOT NULL CHECK (previous_price > 0 AND previous_price <= 1000),
          new_price NUMERIC(8, 2) NOT NULL CHECK (new_price > 0 AND new_price <= 1000),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          read_at TIMESTAMPTZ
        )
      `)
      await pool.query('CREATE INDEX IF NOT EXISTS in_app_notifications_latest_idx ON in_app_notifications (user_id, created_at DESC)')
    }).then(() => undefined).catch((error: unknown) => {
      fuelPricingSchema = null
      throw error
    })
  }
  return fuelPricingSchema
}

async function recordFuelPriceChange(
  client: PoolClient,
  stationId: number,
  updatedBy: number,
  fuelType: string,
  previousPrice: number | null,
  newPrice: number,
) {
  if (previousPrice === null || previousPrice === newPrice) return

  await client.query(
    'INSERT INTO fuel_price_history (station_id, user_id, fuel_type, previous_price, new_price) VALUES ($1, $2, $3, $4, $5)',
    [stationId, updatedBy, fuelType, previousPrice, newPrice],
  )
  await client.query(`
    INSERT INTO in_app_notifications (user_id, type, station_id, station_name, fuel_type, previous_price, new_price)
    SELECT u.id, $2, s.id, s.name, $3, $4, $5
    FROM users u CROSS JOIN stations s
    WHERE u.role = 'user' AND s.id = $1
  `, [stationId, newPrice > previousPrice ? 'price_increase' : 'price_rollback', fuelType, previousPrice, newPrice])
}

function authRequired(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization')
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in to continue.' })
  try {
    const claims = jwt.verify(header.slice(7), jwtSecret!) as jwt.JwtPayload
    ;(req as AuthedRequest).auth = { id: Number(claims.sub), role: claims.role as Role, stationId: claims.stationId ? Number(claims.stationId) : null, name: claims.name, email: claims.email }
    next()
  } catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }) }
}

async function adminRequired(req: Request, res: Response, next: NextFunction) {
  const auth = (req as AuthedRequest).auth
  if (!auth) return res.status(401).json({ error: 'Sign in to continue.' })
  try {
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [auth.id])
    if (rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' })
    next()
  } catch (error) {
    next(error)
  }
}

function validCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
}

async function stationsWithPrices(stations: StationRow[]) {
  if (!stations.length) return []
  await ensureFuelPricingSchema()
  const ids = stations.map((station) => station.id)
  const [{ rows: prices }, { rows: reports }] = await Promise.all([
    pool.query("SELECT id, station_id, fuel_type, price, source, updated_at FROM fuel_prices WHERE station_id = ANY($1::bigint[]) AND source = 'station' ORDER BY fuel_type", [ids]),
    pool.query(`
      SELECT id, station_id, fuel_type, price, created_at FROM (
        SELECT id, station_id, fuel_type, price, created_at,
          row_number() OVER (PARTITION BY station_id, fuel_type ORDER BY created_at DESC) AS report_rank
        FROM fuel_price_reports WHERE station_id = ANY($1::bigint[])
      ) recent WHERE report_rank <= 3 ORDER BY station_id, fuel_type, created_at DESC
    `, [ids]),
  ])
  return stations.map((station) => ({
    id: station.id, name: station.name, brand: station.brand, address: station.address,
    latitude: Number(station.latitude), longitude: Number(station.longitude), distanceKm: Number(station.distance_km),
    sourceRef: station.source_ref ?? null,
    prices: prices.filter((price) => price.station_id === station.id).map((price) => ({ id: price.id, fuelType: price.fuel_type, price: Number(price.price), source: price.source, updatedAt: price.updated_at })),
    reports: reports.filter((report) => report.station_id === station.id).map((report) => ({ id: report.id, fuelType: report.fuel_type, price: Number(report.price), createdAt: report.created_at })),
  }))
}

async function getStation(id: number, latitude = 14.5668, longitude = 121.0457) {
  const { rows } = await pool.query<StationRow>(
    `SELECT id, name, brand, address, latitude, longitude, source_ref,
      6371 * 2 * asin(sqrt(power(sin(radians(latitude - $2) / 2), 2) + cos(radians($2)) * cos(radians(latitude)) * power(sin(radians(longitude - $3) / 2), 2))) AS distance_km
     FROM stations WHERE id = $1`, [id, latitude, longitude],
  )
  return (await stationsWithPrices(rows))[0] ?? null
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

app.get('/api/vehicles/years', async (_req, res, next) => {
  try {
    const $ = await getEpaXml('vehicle/menu/year')
    res.json(epaMenuItems($).map((item) => Number(item.value)).filter(validVehicleYear))
  } catch (error) { next(error) }
})

app.get('/api/vehicles/motorcycles/years', (_req, res) => {
  const years: number[] = []
  for (let year = new Date().getFullYear() + 1; year >= 1981; year -= 1) years.push(year)
  res.json(years)
})

app.get('/api/vehicles/motorcycles/makes', async (_req, res, next) => {
  try {
    const results = await getNhtsaResults<NhtsaMake>('GetMakesForVehicleType/motorcycle')
    const makes = [...new Set(results
      .filter((item) => item.VehicleTypeName?.toLowerCase() === 'motorcycle' && typeof item.MakeName === 'string')
      .map((item) => item.MakeName.trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
    res.json(makes)
  } catch (error) { next(error) }
})

app.get('/api/vehicles/motorcycles/models', async (req, res, next) => {
  const year = Number(req.query.year)
  const make = req.query.make
  if (!validMotorcycleYear(year) || !vehicleField(make, 80)) {
    return res.status(400).json({ error: 'Choose a supported motorcycle model year and make.' })
  }
  try {
    const models = await getNhtsaMotorcycleModels(year, make)
    res.json([...new Set(models.map((item) => item.Model_Name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
  } catch (error) { next(error) }
})

app.get('/api/vehicles/makes', async (req, res, next) => {
  const year = Number(req.query.year)
  if (!validVehicleYear(year)) return res.status(400).json({ error: 'Choose a supported model year.' })
  try {
    const $ = await getEpaXml('vehicle/menu/make', { year: String(year) })
    res.json(epaMenuItems($).map((item) => item.value))
  } catch (error) { next(error) }
})

app.get('/api/vehicles/models', async (req, res, next) => {
  const year = Number(req.query.year)
  const make = req.query.make
  if (!validVehicleYear(year) || !vehicleField(make, 80)) return res.status(400).json({ error: 'Choose a supported model year and vehicle make.' })
  try {
    const $ = await getEpaXml('vehicle/menu/model', { year: String(year), make })
    res.json(epaMenuItems($).map((item) => item.value))
  } catch (error) { next(error) }
})

app.get('/api/vehicles/options', async (req, res, next) => {
  const year = Number(req.query.year)
  const make = req.query.make
  const model = req.query.model
  if (!validVehicleYear(year) || !vehicleField(make, 80) || !vehicleField(model, 100)) {
    return res.status(400).json({ error: 'Choose a supported model year, make, and model.' })
  }
  try {
    const $ = await getEpaXml('vehicle/menu/options', { year: String(year), make, model })
    res.json(epaMenuItems($).flatMap((item) => {
      const epaId = Number(item.value)
      return Number.isInteger(epaId) && epaId > 0 ? [{ label: item.label, epaId }] : []
    }))
  } catch (error) { next(error) }
})

app.get('/api/vehicles/:id', async (req, res, next) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Vehicle catalog ID is invalid.' })
  try { res.json(await getEpaVehicle(id)) }
  catch (error) { next(error) }
})

app.post('/api/auth/register', async (req, res, next) => {
  const { name, email, password, role, vehicle, stationName, address, latitude, longitude } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Enter your name, a valid email, and a password of at least 8 characters.' })
  }
  if (!['user', 'station'].includes(role)) return res.status(400).json({ error: 'Choose a valid account type.' })
  let savedVehicle: VehicleRecord | null = null
  if (role === 'user') {
    if (!vehicle || !vehicleCategories.includes(vehicle.category) || !vehicleField(vehicle.make, 80) ||
        !vehicleField(vehicle.model, 100) || !vehicleField(vehicle.variant, 80) || !vehicleField(vehicle.version, 100) ||
        !Number.isInteger(vehicle.year) || vehicle.year < 1981 || vehicle.year > new Date().getFullYear() + 1) {
      return res.status(400).json({ error: 'Enter the vehicle kind, year, make, model, variant, and version.' })
    }
    if (vehicle.category === 'Motorcycle') {
      if (!validMotorcycleYear(vehicle.year)) return res.status(400).json({ error: 'Choose a supported motorcycle model year.' })
      savedVehicle = {
        category: 'Motorcycle',
        epaId: null,
        make: vehicle.make.trim(),
        model: vehicle.model.trim(),
        type: null,
        variant: vehicle.variant.trim(),
        version: vehicle.version.trim(),
        year: vehicle.year,
        fuelType: 'Gasoline',
        fuelEconomyKmL: 35,
        economySource: 'Typical estimate',
      }
    } else {
      if (!Number.isInteger(vehicle.epaId) || vehicle.epaId < 1) {
        return res.status(400).json({ error: 'Select a matching vehicle version from the EPA catalog.' })
      }
      const catalogVehicle = await getEpaVehicle(vehicle.epaId)
      if (catalogVehicle.year !== vehicle.year || catalogVehicle.make !== vehicle.make || catalogVehicle.model !== vehicle.model) {
        return res.status(400).json({ error: 'The selected vehicle does not match the catalog record. Please select it again.' })
      }
      savedVehicle = { ...catalogVehicle, category: vehicle.category, variant: vehicle.variant.trim(), economySource: 'EPA' }
    }
  }
  if (role === 'station' && (typeof stationName !== 'string' || !stationName.trim() || typeof address !== 'string' || !address.trim() || !validCoordinates(Number(latitude), Number(longitude)))) {
    return res.status(400).json({ error: 'Station name, address, latitude, and longitude are required.' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const passwordHash = await bcrypt.hash(password, 12)
    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash, role, vehicle_category, vehicle_type, vehicle_make, vehicle_model, vehicle_variant, vehicle_version, vehicle_year, vehicle_fuel_type, vehicle_economy_km_l, vehicle_epa_id)
       VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, name, email, role, created_at`,
      [name.trim(), email.trim(), passwordHash, role, savedVehicle?.category ?? null, savedVehicle?.type ?? null, savedVehicle?.make ?? null, savedVehicle?.model ?? null, savedVehicle?.variant ?? null, savedVehicle?.version ?? null, savedVehicle?.year ?? null, savedVehicle?.fuelType ?? null, savedVehicle?.fuelEconomyKmL ?? null, savedVehicle?.epaId ?? null],
    )
    const user = userResult.rows[0]
    let stationId: number | null = null
    if (role === 'station') {
      const stationResult = await client.query(
        'INSERT INTO stations (owner_id, name, brand, address, latitude, longitude) VALUES ($1, $2, $2, $3, $4, $5) RETURNING id',
        [user.id, stationName.trim(), address.trim(), Number(latitude), Number(longitude)],
      )
      stationId = stationResult.rows[0].id
    }
    await client.query('COMMIT')
    const account = { id: user.id, name: user.name, email: user.email, role: user.role, stationId, searchRadiusKm: 25, vehicle: savedVehicle, createdAt: user.created_at }
    const token = jwt.sign({ sub: user.id, name: user.name, email: user.email, role: user.role, stationId }, jwtSecret!, { expiresIn: '7d' })
    res.status(201).json({ token, account })
  } catch (error) { await client.query('ROLLBACK'); next(error) }
  finally { client.release() }
})

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password, accountType } = req.body ?? {}
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password are required.' })
    if (accountType !== undefined && !['user', 'station', 'admin'].includes(accountType)) {
      return res.status(400).json({ error: 'Choose a valid account type.' })
    }
    const { rows } = await pool.query('SELECT id, name, email, role, password_hash, search_radius_km, vehicle_category, vehicle_epa_id, vehicle_make, vehicle_model, vehicle_type, vehicle_variant, vehicle_version, vehicle_year, vehicle_fuel_type, vehicle_economy_km_l, created_at FROM users WHERE email = lower($1)', [email.trim()])
    const user = rows[0]
    if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' })
    if (accountType && user.role !== accountType) {
      const accountLabel = user.role === 'admin' ? 'administrator' : user.role === 'station' ? 'station owner' : 'driver'
      return res.status(403).json({ error: `This account is registered as a ${accountLabel}. Select the matching account type.` })
    }
    const stationResult = user.role === 'station' ? await pool.query('SELECT id FROM stations WHERE owner_id = $1', [user.id]) : { rows: [] }
    const stationId = stationResult.rows[0]?.id ?? null
    const account = { id: user.id, name: user.name, email: user.email, role: user.role, stationId, searchRadiusKm: user.search_radius_km, vehicle: mapVehicle(user), createdAt: user.created_at }
    const token = jwt.sign({ sub: user.id, name: user.name, email: user.email, role: user.role, stationId }, jwtSecret!, { expiresIn: '7d' })
    res.json({ token, account })
  } catch (error) { next(error) }
})

app.get('/api/auth/me', authRequired, async (req, res, next) => {
  try {
    const auth = (req as AuthedRequest).auth!
    const { rows } = await pool.query('SELECT id, name, email, role, search_radius_km, vehicle_category, vehicle_epa_id, vehicle_make, vehicle_model, vehicle_type, vehicle_variant, vehicle_version, vehicle_year, vehicle_fuel_type, vehicle_economy_km_l, created_at FROM users WHERE id = $1', [auth.id])
    if (!rows[0]) return res.status(404).json({ error: 'Account not found.' })
    const latitude = Number(req.query.lat ?? 14.5668)
    const longitude = Number(req.query.lng ?? 121.0457)
    const station = auth.stationId
      ? await getStation(auth.stationId, validCoordinates(latitude, longitude) ? latitude : 14.5668, validCoordinates(latitude, longitude) ? longitude : 121.0457)
      : null
    res.json({ account: { id: auth.id, name: rows[0].name, email: rows[0].email, role: rows[0].role, stationId: auth.stationId, searchRadiusKm: rows[0].search_radius_km, vehicle: mapVehicle(rows[0]), createdAt: rows[0].created_at }, station })
  } catch (error) { next(error) }
})

app.patch('/api/auth/profile', authRequired, async (req, res, next) => {
  try {
    const auth = (req as AuthedRequest).auth!
    const { name, email, currentPassword, newPassword, searchRadiusKm, vehicle } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Enter a valid name and email address.' })
    }
    if (searchRadiusKm !== undefined && (!Number.isInteger(searchRadiusKm) || searchRadiusKm < 5 || searchRadiusKm > 200 || searchRadiusKm % 5 !== 0)) {
      return res.status(400).json({ error: 'Choose a search radius from 5 to 200 km in increments of 5.' })
    }
    let savedVehicle: VehicleRecord | null | undefined
    if (auth.role === 'user') {
      if (!vehicle || !vehicleCategories.includes(vehicle.category) || !vehicleField(vehicle.make, 80) ||
          !vehicleField(vehicle.model, 100) || !vehicleField(vehicle.variant, 80) || !vehicleField(vehicle.version, 100) ||
          !Number.isInteger(vehicle.year) || vehicle.year < 1981 || vehicle.year > new Date().getFullYear() + 1) {
        return res.status(400).json({ error: 'Enter the vehicle kind, year, make, model, variant, and version.' })
      }
      if (vehicle.category === 'Motorcycle') {
        if (!validMotorcycleYear(vehicle.year)) return res.status(400).json({ error: 'Choose a supported motorcycle model year.' })
        savedVehicle = {
          category: 'Motorcycle',
          epaId: null,
          make: vehicle.make.trim(),
          model: vehicle.model.trim(),
          type: null,
          variant: vehicle.variant.trim(),
          version: vehicle.version.trim(),
          year: vehicle.year,
          fuelType: 'Gasoline',
          fuelEconomyKmL: 35,
          economySource: 'Typical estimate',
        }
      } else {
        if (!Number.isInteger(vehicle.epaId) || vehicle.epaId < 1) {
          return res.status(400).json({ error: 'Select a matching vehicle version from the EPA catalog.' })
        }
        const catalogVehicle = await getEpaVehicle(vehicle.epaId)
        if (catalogVehicle.year !== vehicle.year || catalogVehicle.make !== vehicle.make || catalogVehicle.model !== vehicle.model) {
          return res.status(400).json({ error: 'The selected vehicle does not match the catalog record. Please select it again.' })
        }
        savedVehicle = { ...catalogVehicle, category: vehicle.category, variant: vehicle.variant.trim(), economySource: 'EPA' }
      }
    }
    if (newPassword !== undefined && (typeof newPassword !== 'string' || newPassword.length < 8 || typeof currentPassword !== 'string')) {
      return res.status(400).json({ error: 'Enter your current password and a new password of at least 8 characters.' })
    }

    const { rows: users } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [auth.id])
    if (!users[0]) return res.status(404).json({ error: 'Account not found.' })
    if (newPassword !== undefined && !await bcrypt.compare(currentPassword, users[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' })
    }

    const passwordHash = newPassword === undefined ? users[0].password_hash : await bcrypt.hash(newPassword, 12)
    const { rows } = await pool.query(
      `UPDATE users SET name = $1, email = lower($2), password_hash = $3, search_radius_km = COALESCE($4, search_radius_km),
       vehicle_category = COALESCE($5, vehicle_category), vehicle_type = CASE WHEN $5 IS NULL THEN vehicle_type ELSE $6 END,
       vehicle_make = COALESCE($7, vehicle_make), vehicle_model = COALESCE($8, vehicle_model),
       vehicle_variant = COALESCE($9, vehicle_variant), vehicle_version = COALESCE($10, vehicle_version), vehicle_year = COALESCE($11, vehicle_year),
       vehicle_fuel_type = COALESCE($12, vehicle_fuel_type), vehicle_economy_km_l = COALESCE($13, vehicle_economy_km_l), vehicle_epa_id = $14
       WHERE id = $15 RETURNING id, name, email, role, search_radius_km, vehicle_category, vehicle_epa_id, vehicle_make, vehicle_model, vehicle_type, vehicle_variant, vehicle_version, vehicle_year, vehicle_fuel_type, vehicle_economy_km_l, created_at`,
      [name.trim(), email.trim(), passwordHash, searchRadiusKm ?? null, savedVehicle?.category ?? null, savedVehicle?.type ?? null, savedVehicle?.make ?? null, savedVehicle?.model ?? null, savedVehicle?.variant ?? null, savedVehicle?.version ?? null, savedVehicle?.year ?? null, savedVehicle?.fuelType ?? null, savedVehicle?.fuelEconomyKmL ?? null, savedVehicle?.epaId ?? null, auth.id],
    )
    const user = rows[0]
    const account = { id: user.id, name: user.name, email: user.email, role: user.role, stationId: auth.stationId, searchRadiusKm: user.search_radius_km, vehicle: savedVehicle ?? mapVehicle(user), createdAt: user.created_at }
    const token = jwt.sign({ sub: user.id, name: user.name, email: user.email, role: user.role, stationId: auth.stationId }, jwtSecret!, { expiresIn: '7d' })
    res.json({ account, token })
  } catch (error) { next(error) }
})

app.get('/api/user/financial-records', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  if (auth.role !== 'user') return res.status(403).json({ error: 'Driver account access is required.' })
  try {
    await ensureFuelPricingSchema()
    const { rows } = await pool.query(`
      SELECT id, fuel_type, liters::float8 AS liters, price_per_liter::float8 AS price_per_liter,
        (liters * price_per_liter)::numeric(12, 2)::float8 AS total_cost, station_name, purchased_at, created_at
      FROM user_fuel_expenses WHERE user_id = $1
      ORDER BY purchased_at DESC, id DESC LIMIT 200
    `, [auth.id])
    res.json({ records: rows })
  } catch (error) { next(error) }
})

app.post('/api/user/financial-records', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  if (auth.role !== 'user') return res.status(403).json({ error: 'Driver account access is required.' })
  const { fuelType, liters, pricePerLiter, stationName, purchasedAt } = req.body ?? {}
  if (typeof fuelType !== 'string' || !['Unleaded', 'Diesel', 'Premium'].includes(fuelType) ||
      typeof liters !== 'number' || !Number.isFinite(liters) || liters <= 0 || liters > 10000 ||
      Number(liters.toFixed(2)) !== liters ||
      typeof pricePerLiter !== 'number' || !Number.isFinite(pricePerLiter) || pricePerLiter <= 0 || pricePerLiter > 1000 ||
      Number(pricePerLiter.toFixed(2)) !== pricePerLiter) {
    return res.status(400).json({ error: 'Enter a valid fuel type, quantity, and price per liter.' })
  }
  if (stationName !== undefined && stationName !== null && (typeof stationName !== 'string' || stationName.trim().length > 120)) {
    return res.status(400).json({ error: 'Station name must be 120 characters or fewer.' })
  }
  const purchaseDate = purchasedAt ?? new Date().toISOString().slice(0, 10)
  if (typeof purchaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) ||
      Number.isNaN(Date.parse(`${purchaseDate}T00:00:00Z`)) ||
      new Date(`${purchaseDate}T00:00:00Z`).toISOString().slice(0, 10) !== purchaseDate ||
      purchaseDate > new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Choose a valid purchase date.' })
  }
  try {
    await ensureFuelPricingSchema()
    const { rows } = await pool.query(`
      INSERT INTO user_fuel_expenses (user_id, fuel_type, liters, price_per_liter, station_name, purchased_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, fuel_type, liters::float8 AS liters, price_per_liter::float8 AS price_per_liter,
        (liters * price_per_liter)::numeric(12, 2)::float8 AS total_cost, station_name, purchased_at, created_at
    `, [auth.id, fuelType, liters, pricePerLiter, stationName?.trim() || null, purchaseDate])
    res.status(201).json({ record: rows[0] })
  } catch (error) { next(error) }
})

app.delete('/api/user/financial-records/:id', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const id = Number(req.params.id)
  if (auth.role !== 'user') return res.status(403).json({ error: 'Driver account access is required.' })
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Financial record ID is invalid.' })
  try {
    const { rowCount } = await pool.query('DELETE FROM user_fuel_expenses WHERE id = $1 AND user_id = $2', [id, auth.id])
    if (!rowCount) return res.status(404).json({ error: 'Financial record not found.' })
    res.json({ deleted: true })
  } catch (error) { next(error) }
})

app.get('/api/notifications', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  if (auth.role !== 'user') return res.status(403).json({ error: 'Driver account access is required.' })
  try {
    await ensureFuelPricingSchema()
    const [{ rows: notifications }, { rows: counts }] = await Promise.all([
      pool.query(`
        SELECT id, type, station_name, fuel_type, previous_price::float8 AS previous_price,
          new_price::float8 AS new_price, created_at, read_at
        FROM in_app_notifications WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 100
      `, [auth.id]),
      pool.query('SELECT count(*)::int AS unread_count FROM in_app_notifications WHERE user_id = $1 AND read_at IS NULL', [auth.id]),
    ])
    res.json({ notifications, unreadCount: counts[0].unread_count })
  } catch (error) { next(error) }
})

app.patch('/api/notifications/read-all', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  if (auth.role !== 'user') return res.status(403).json({ error: 'Driver account access is required.' })
  try {
    await ensureFuelPricingSchema()
    await pool.query('UPDATE in_app_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [auth.id])
    res.json({ updated: true })
  } catch (error) { next(error) }
})

app.patch('/api/notifications/:id/read', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const id = Number(req.params.id)
  if (auth.role !== 'user') return res.status(403).json({ error: 'Driver account access is required.' })
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Notification ID is invalid.' })
  try {
    await ensureFuelPricingSchema()
    const { rowCount } = await pool.query(
      'UPDATE in_app_notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2',
      [id, auth.id],
    )
    if (!rowCount) return res.status(404).json({ error: 'Notification not found.' })
    res.json({ updated: true })
  } catch (error) { next(error) }
})

app.get('/api/admin/overview', authRequired, adminRequired, async (_req, res, next) => {
  try {
    await ensureFuelPricingSchema()
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM users) AS total_users,
        (SELECT count(*)::int FROM users WHERE role = 'user') AS drivers,
        (SELECT count(*)::int FROM users WHERE role = 'station') AS station_owners,
        (SELECT count(*)::int FROM users WHERE role = 'admin') AS admins,
        (SELECT count(*)::int FROM stations) AS stations,
        (SELECT count(*)::int FROM fuel_prices WHERE source = 'station') AS current_prices,
        (SELECT count(*)::int FROM fuel_price_history) AS price_changes,
        (SELECT count(*)::int FROM fuel_price_reports) AS community_reports,
        (SELECT count(*)::int FROM fuel_price_reports WHERE created_at > now() - interval '7 days') AS reports_this_week
    `)
    res.json({ overview: rows[0] })
  } catch (error) { next(error) }
})

app.get('/api/admin/users', authRequired, adminRequired, async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? `%${req.query.search.trim()}%` : null
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.created_at,
        s.id AS station_id, s.name AS station_name,
        (SELECT count(*)::int FROM fuel_price_reports r WHERE r.user_id = u.id) AS report_count
      FROM users u
      LEFT JOIN stations s ON s.owner_id = u.id
      WHERE $1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR s.name ILIKE $1
      ORDER BY u.created_at DESC LIMIT 500
    `, [search])
    res.json({ users: rows })
  } catch (error) { next(error) }
})

app.patch('/api/admin/users/:id', authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id)
  const { name, email } = req.body ?? {}
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'User ID is invalid.' })
  if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid name and email address.' })
  }
  try {
    const { rows } = await pool.query(
      'UPDATE users SET name = $1, email = lower($2) WHERE id = $3 AND role <> \'admin\' RETURNING id, name, email, role, created_at',
      [name.trim(), email.trim(), id],
    )
    if (!rows[0]) return res.status(404).json({ error: 'User not found or administrator accounts cannot be edited here.' })
    res.json({ user: rows[0] })
  } catch (error) { next(error) }
})

app.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'User ID is invalid.' })
  if (id === auth.id) return res.status(400).json({ error: 'You cannot delete the administrator account you are using.' })
  try {
    const { rows } = await pool.query('DELETE FROM users WHERE id = $1 AND role <> \'admin\' RETURNING id', [id])
    if (!rows[0]) return res.status(404).json({ error: 'User not found or administrator accounts cannot be deleted here.' })
    res.json({ deletedId: Number(rows[0].id) })
  } catch (error) { next(error) }
})

app.get('/api/admin/stations', authRequired, adminRequired, async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? `%${req.query.search.trim()}%` : null
    const { rows } = await pool.query(`
      SELECT s.id, s.name, s.brand, s.address, s.latitude, s.longitude, s.created_at, s.source_ref,
        u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
        count(DISTINCT fp.id)::int AS price_count,
        count(DISTINCT r.id)::int AS report_count
      FROM stations s
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN fuel_prices fp ON fp.station_id = s.id
      LEFT JOIN fuel_price_reports r ON r.station_id = s.id
      WHERE $1::text IS NULL OR s.name ILIKE $1 OR s.brand ILIKE $1 OR s.address ILIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1
      GROUP BY s.id, u.id
      ORDER BY s.created_at DESC LIMIT 500
    `, [search])
    res.json({ stations: rows })
  } catch (error) { next(error) }
})

app.patch('/api/admin/stations/:id', authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id)
  const { name, brand, address, latitude, longitude } = req.body ?? {}
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Station ID is invalid.' })
  if (typeof name !== 'string' || !name.trim() || typeof brand !== 'string' || !brand.trim() || typeof address !== 'string' || !address.trim() || !validCoordinates(Number(latitude), Number(longitude))) {
    return res.status(400).json({ error: 'Enter a station name, brand, address, and valid coordinates.' })
  }
  try {
    const { rows } = await pool.query(
      'UPDATE stations SET name = $1, brand = $2, address = $3, latitude = $4, longitude = $5 WHERE id = $6 RETURNING id, name, brand, address, latitude, longitude',
      [name.trim(), brand.trim(), address.trim(), Number(latitude), Number(longitude), id],
    )
    if (!rows[0]) return res.status(404).json({ error: 'Station not found.' })
    res.json({ station: rows[0] })
  } catch (error) { next(error) }
})

app.delete('/api/admin/stations/:id', authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Station ID is invalid.' })
  try {
    const { rows } = await pool.query('DELETE FROM stations WHERE id = $1 RETURNING id', [id])
    if (!rows[0]) return res.status(404).json({ error: 'Station not found.' })
    res.json({ deletedId: Number(rows[0].id) })
  } catch (error) { next(error) }
})

app.get('/api/admin/prices', authRequired, adminRequired, async (req, res, next) => {
  try {
    await ensureFuelPricingSchema()
    const search = typeof req.query.search === 'string' ? `%${req.query.search.trim()}%` : null
    const { rows } = await pool.query(`
      SELECT fp.id, fp.station_id, s.name AS station_name, s.brand, s.address,
        u.name AS owner_name, fp.fuel_type, fp.price::float8 AS price, fp.source, fp.updated_at,
        history.previous_price::float8 AS previous_price,
        history.new_price::float8 AS changed_price,
        history.recorded_at AS change_at,
        history.editor_name
      FROM fuel_prices fp
      JOIN stations s ON s.id = fp.station_id
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN LATERAL (
        SELECT h.previous_price, h.new_price, h.recorded_at, editor.name AS editor_name
        FROM fuel_price_history h
        LEFT JOIN users editor ON editor.id = h.user_id
        WHERE h.station_id = fp.station_id AND h.fuel_type = fp.fuel_type
        ORDER BY h.recorded_at DESC LIMIT 1
      ) history ON true
      WHERE $1::text IS NULL OR s.name ILIKE $1 OR s.brand ILIKE $1 OR s.address ILIKE $1 OR fp.fuel_type ILIKE $1 OR u.name ILIKE $1
      ORDER BY fp.updated_at DESC LIMIT 500
    `, [search])
    res.json({ prices: rows })
  } catch (error) { next(error) }
})

app.post('/api/admin/prices', authRequired, adminRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const { stationId, fuelType, price } = req.body ?? {}
  const id = Number(stationId)
  const nextPrice = Number(price)
  if (!Number.isSafeInteger(id) || id <= 0 || typeof fuelType !== 'string' || !['Unleaded', 'Diesel', 'Premium'].includes(fuelType) || !Number.isFinite(nextPrice) || nextPrice <= 0 || nextPrice > 1000) {
    return res.status(400).json({ error: 'Choose a station, fuel type, and valid price.' })
  }
  try {
    await ensureFuelPricingSchema()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: existing } = await client.query('SELECT price FROM fuel_prices WHERE station_id = $1 AND fuel_type = $2 FOR UPDATE', [id, fuelType])
      const previousPrice = existing[0] ? Number(existing[0].price) : null
      await client.query(
        'INSERT INTO fuel_prices (station_id, fuel_type, price, source) VALUES ($1, $2, $3, \'station\') ON CONFLICT (station_id, fuel_type) DO UPDATE SET price = EXCLUDED.price, source = \'station\', updated_at = now()',
        [id, fuelType, nextPrice],
      )
      await recordFuelPriceChange(client, id, auth.id, fuelType, previousPrice, nextPrice)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    res.status(201).json({ prices: (await getStation(id))?.prices ?? [] })
  } catch (error) { next(error) }
})

app.delete('/api/admin/prices/:id', authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Price ID is invalid.' })
  try {
    const { rows } = await pool.query('DELETE FROM fuel_prices WHERE id = $1 RETURNING id', [id])
    if (!rows[0]) return res.status(404).json({ error: 'Fuel price not found.' })
    res.json({ deletedId: Number(rows[0].id) })
  } catch (error) { next(error) }
})

app.get('/api/admin/reports', authRequired, adminRequired, async (req, res, next) => {
  try {
    await ensureFuelPricingSchema()
    const search = typeof req.query.search === 'string' ? `%${req.query.search.trim()}%` : null
    const { rows } = await pool.query(`
      SELECT r.id, r.station_id, s.name AS station_name, s.brand, s.address,
        r.user_id, u.name AS reporter_name, u.email AS reporter_email,
        r.fuel_type, r.price::float8 AS price, r.created_at
      FROM fuel_price_reports r
      JOIN stations s ON s.id = r.station_id
      JOIN users u ON u.id = r.user_id
      WHERE $1::text IS NULL OR s.name ILIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1 OR r.fuel_type ILIKE $1
      ORDER BY r.created_at DESC LIMIT 500
    `, [search])
    res.json({ reports: rows })
  } catch (error) { next(error) }
})

app.delete('/api/admin/reports/:id', authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Report ID is invalid.' })
  try {
    const { rows } = await pool.query('DELETE FROM fuel_price_reports WHERE id = $1 RETURNING id', [id])
    if (!rows[0]) return res.status(404).json({ error: 'Community report not found.' })
    res.json({ deletedId: Number(rows[0].id) })
  } catch (error) { next(error) }
})

app.post('/api/stations/:id/claim', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const stationId = Number(req.params.id)
  if (auth.role !== 'station') return res.status(403).json({ error: 'Create or sign in with a station-owner account to claim a station.' })
  if (!Number.isSafeInteger(stationId) || stationId <= 0) return res.status(400).json({ error: 'Station ID is invalid.' })

  const client = await pool.connect()
  try {
    await ensureFuelPricingSchema()
    await client.query('BEGIN')
    const { rows: targets } = await client.query('SELECT id, owner_id, source_ref FROM stations WHERE id = $1 FOR UPDATE', [stationId])
    const target = targets[0]
    if (!target || !target.source_ref || String(target.source_ref).startsWith('sample:')) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'This imported OSM station cannot be claimed.' })
    }
    if (target.owner_id !== null && Number(target.owner_id) !== auth.id) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'This station is already linked to another owner account.' })
    }

    const { rows: ownedStations } = await client.query('SELECT id FROM stations WHERE owner_id = $1 FOR UPDATE', [auth.id])
    const previousStationId = ownedStations[0]?.id
    if (previousStationId && Number(previousStationId) !== stationId) {
      await client.query(
        `INSERT INTO fuel_prices (station_id, fuel_type, price, updated_at)
         SELECT $1, fuel_type, price, updated_at FROM fuel_prices WHERE station_id = $2
         ON CONFLICT (station_id, fuel_type) DO NOTHING`,
        [stationId, previousStationId],
      )
      await client.query('UPDATE fuel_price_reports SET station_id = $1 WHERE station_id = $2', [stationId, previousStationId])
      await client.query('UPDATE stations SET owner_id = NULL WHERE id = $1', [previousStationId])
      await client.query('DELETE FROM stations WHERE id = $1', [previousStationId])
    }
    await client.query('UPDATE stations SET owner_id = $1 WHERE id = $2', [auth.id, stationId])
    await client.query('COMMIT')

    const account = { id: auth.id, name: auth.name, email: auth.email, role: auth.role, stationId }
    const token = jwt.sign({ sub: auth.id, name: auth.name, email: auth.email, role: auth.role, stationId }, jwtSecret!, { expiresIn: '7d' })
    res.json({ token, account, station: await getStation(stationId) })
  } catch (error) {
    await client.query('ROLLBACK')
    next(error)
  } finally {
    client.release()
  }
})

app.get('/api/stations', authRequired, async (req, res, next) => {
  try {
    const latitude = Number(req.query.lat ?? 14.5668)
    const longitude = Number(req.query.lng ?? 121.0457)
    const radiusKm = Number(req.query.radiusKm ?? 15)
    const nationwide = req.query.nationwide === 'true'
    if (!validCoordinates(latitude, longitude) || (!nationwide && (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 100))) return res.status(400).json({ error: 'Choose a valid location and radius.' })
    const { rows } = nationwide
      ? await pool.query<StationRow>(
          `SELECT id, name, brand, address, latitude, longitude, source_ref,
            6371 * 2 * asin(sqrt(power(sin(radians(latitude - $1) / 2), 2) + cos(radians($1)) * cos(radians(latitude)) * power(sin(radians(longitude - $2) / 2), 2))) AS distance_km
           FROM stations ORDER BY distance_km LIMIT 15000`, [latitude, longitude],
        )
      : await pool.query<StationRow>(
          `WITH nearby AS (
            SELECT id, name, brand, address, latitude, longitude, source_ref,
              6371 * 2 * asin(sqrt(power(sin(radians(latitude - $1) / 2), 2) + cos(radians($1)) * cos(radians(latitude)) * power(sin(radians(longitude - $2) / 2), 2))) AS distance_km
            FROM stations
          ) SELECT * FROM nearby WHERE distance_km <= $3 ORDER BY distance_km LIMIT 100`, [latitude, longitude, radiusKm],
        )
    res.json({ stations: await stationsWithPrices(rows) })
  } catch (error) { next(error) }
})

app.get('/api/national-price-watch', authRequired, async (_req, res, next) => {
  try {
    res.json(await getNationalFuelAdvisory())
  } catch (error) {
    console.error('DOE national price refresh failed:', error)
    res.status(502).json({ error: error instanceof Error ? error.message : 'DOE national pricing is unavailable.' })
  }
})

app.get('/api/price-watch', authRequired, async (req, res, next) => {
  try {
    await ensureFuelPricingSchema()
    const fuelType = typeof req.query.fuelType === 'string' && ['Unleaded', 'Diesel', 'Premium'].includes(req.query.fuelType)
      ? req.query.fuelType
      : null
    const { rows: summary } = await pool.query(`
      WITH latest_owner_prices AS (
        SELECT fp.station_id, fp.fuel_type, fp.price, fp.updated_at,
          history.previous_price, history.new_price AS recorded_price, history.recorded_at
        FROM fuel_prices fp
        LEFT JOIN LATERAL (
          SELECT previous_price, new_price, recorded_at FROM fuel_price_history
          WHERE station_id = fp.station_id AND fuel_type = fp.fuel_type AND previous_price IS NOT NULL
          ORDER BY recorded_at DESC LIMIT 1
        ) history ON true
        WHERE fp.source = 'station' AND ($1::text IS NULL OR fp.fuel_type = $1)
      )
      SELECT fuel_type,
        count(*)::int AS station_count,
        round(avg(price), 2)::float8 AS average_price,
        min(price)::float8 AS lowest_price,
        max(price)::float8 AS highest_price,
        round(avg(recorded_price - previous_price) FILTER (WHERE recorded_price IS NOT NULL), 2)::float8 AS average_change,
        count(*) FILTER (WHERE recorded_price < previous_price)::int AS rollback_count,
        count(*) FILTER (WHERE recorded_price > previous_price)::int AS increase_count
      FROM latest_owner_prices GROUP BY fuel_type ORDER BY fuel_type
    `, [fuelType])
    const { rows: prices } = await pool.query(`
      SELECT s.id AS station_id, s.name, s.brand, s.address, fp.fuel_type, fp.price::float8 AS current_price, fp.updated_at,
        history.previous_price::float8 AS previous_price,
        (history.new_price - history.previous_price)::float8 AS price_change,
        history.recorded_at AS change_at
      FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
      LEFT JOIN LATERAL (
        SELECT previous_price, new_price, recorded_at FROM fuel_price_history
        WHERE station_id = fp.station_id AND fuel_type = fp.fuel_type AND previous_price IS NOT NULL
        ORDER BY recorded_at DESC LIMIT 1
      ) history ON true
      WHERE fp.source = 'station' AND ($1::text IS NULL OR fp.fuel_type = $1)
      ORDER BY fp.updated_at DESC LIMIT 250
    `, [fuelType])
    res.json({ summary, prices })
  } catch (error) { next(error) }
})

app.post('/api/stations/:id/prices', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const stationId = Number(req.params.id)
  const { fuelType, price } = req.body ?? {}
  if (auth.role !== 'station' || auth.stationId !== stationId) return res.status(403).json({ error: 'Only this station account can manage its fuel prices.' })
  if (typeof fuelType !== 'string' || !['Unleaded', 'Diesel', 'Premium'].includes(fuelType) || !Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) > 1000) return res.status(400).json({ error: 'Enter a valid fuel type and price.' })
  try {
    await ensureFuelPricingSchema()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: existing } = await client.query('SELECT price FROM fuel_prices WHERE station_id = $1 AND fuel_type = $2 FOR UPDATE', [stationId, fuelType])
      const previousPrice = existing[0] ? Number(existing[0].price) : null
      const nextPrice = Number(price)
      await client.query(
        'INSERT INTO fuel_prices (station_id, fuel_type, price, source) VALUES ($1, $2, $3, \'station\') ON CONFLICT (station_id, fuel_type) DO UPDATE SET price = EXCLUDED.price, source = \'station\', updated_at = now()',
        [stationId, fuelType, nextPrice],
      )
      await recordFuelPriceChange(client, stationId, auth.id, fuelType, previousPrice, nextPrice)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    res.json({ prices: (await getStation(stationId))?.prices ?? [] })
  } catch (error) { next(error) }
})

app.put('/api/stations/:id/prices/:fuelType', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const stationId = Number(req.params.id)
  const fuelType = req.params.fuelType
  const { price } = req.body ?? {}
  if (auth.role !== 'station' || auth.stationId !== stationId) return res.status(403).json({ error: 'Only this station account can manage its fuel prices.' })
  if (typeof fuelType !== 'string' || !['Unleaded', 'Diesel', 'Premium'].includes(fuelType) || !Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) > 1000) return res.status(400).json({ error: 'Enter a valid fuel type and price.' })
  try {
    await ensureFuelPricingSchema()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: existing } = await client.query('SELECT price FROM fuel_prices WHERE station_id = $1 AND fuel_type = $2 FOR UPDATE', [stationId, fuelType])
      if (!existing[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'No station price exists for this fuel type yet.' })
      }
      const previousPrice = Number(existing[0].price)
      const nextPrice = Number(price)
      await client.query("UPDATE fuel_prices SET price = $1, source = 'station', updated_at = now() WHERE station_id = $2 AND fuel_type = $3", [nextPrice, stationId, fuelType])
      await recordFuelPriceChange(client, stationId, auth.id, fuelType, previousPrice, nextPrice)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    res.json({ prices: (await getStation(stationId))?.prices ?? [] })
  } catch (error) { next(error) }
})

app.delete('/api/stations/:id/prices/:priceId', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const stationId = Number(req.params.id)
  const priceId = Number(req.params.priceId)
  if (auth.role !== 'station' || auth.stationId !== stationId) return res.status(403).json({ error: 'Only this station account can manage its fuel prices.' })
  try {
    await pool.query('DELETE FROM fuel_prices WHERE id = $1 AND station_id = $2', [priceId, stationId])
    res.json({ prices: (await getStation(stationId))?.prices ?? [] })
  } catch (error) { next(error) }
})

app.post('/api/stations/:id/reports', authRequired, async (req, res, next) => {
  const auth = (req as AuthedRequest).auth!
  const stationId = Number(req.params.id)
  const { fuelType, price } = req.body ?? {}
  if (!Number.isSafeInteger(stationId) || stationId <= 0) return res.status(400).json({ error: 'Station ID is invalid.' })
  if (typeof fuelType !== 'string' || !['Unleaded', 'Diesel', 'Premium'].includes(fuelType) || !Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) > 1000) {
    return res.status(400).json({ error: 'Enter a valid fuel type and price.' })
  }

  try {
    await ensureFuelPricingSchema()
    const { rows: stations } = await pool.query('SELECT id FROM stations WHERE id = $1', [stationId])
    if (!stations.length) return res.status(404).json({ error: 'Station not found.' })
    const { rows: recent } = await pool.query(
      `SELECT count(*)::int AS count FROM fuel_price_reports WHERE user_id = $1 AND created_at > now() - interval '10 minutes'`,
      [auth.id],
    )
    if (recent[0].count >= 10) return res.status(429).json({ error: 'You have reached the report limit. Try again later.' })

    const { rows } = await pool.query(
      'INSERT INTO fuel_price_reports (station_id, user_id, fuel_type, price) VALUES ($1, $2, $3, $4) RETURNING id, fuel_type, price, created_at',
      [stationId, auth.id, fuelType, Number(price)],
    )
    const report = rows[0]
    res.status(201).json({ report: { id: report.id, fuelType: report.fuel_type, price: Number(report.price), createdAt: report.created_at } })
  } catch (error) { next(error) }
})

app.get('/api/route', authRequired, async (req, res, next) => {
  const fromLat = Number(req.query.fromLat)
  const fromLng = Number(req.query.fromLng)
  const toLat = Number(req.query.toLat)
  const toLng = Number(req.query.toLng)
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite) || !validCoordinates(fromLat, fromLng) || !validCoordinates(toLat, toLng)) return res.status(400).json({ error: 'Route coordinates are invalid.' })
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const result = await response.json() as { code?: string; routes?: { geometry: unknown; distance: number; duration: number }[] }
    if (!response.ok || result.code !== 'Ok' || !result.routes?.[0]) return res.status(502).json({ error: 'No driving route is available for these locations.' })
    res.json({ geometry: result.routes[0].geometry, distanceKm: result.routes[0].distance / 1000, durationMinutes: result.routes[0].duration / 60 })
  } catch (error) { next(error) }
})

app.use((error: Error & { code?: string; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' })
  console.error(error)
  res.status(error.statusCode ?? 500).json({ error: error.statusCode ? error.message : 'Something went wrong. Check that the database is configured and try again.' })
})

app.listen(port, () => console.log(`LowGas API listening on http://localhost:${port}`))