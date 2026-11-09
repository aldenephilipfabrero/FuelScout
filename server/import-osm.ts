import './config.js'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'

type GeoJsonFeature = {
  id?: string | number
  properties?: Record<string, unknown> | null
  geometry?: { coordinates?: unknown } | null
}

type ImportedStation = {
  sourceRef: string
  name: string
  brand: string
  address: string
  latitude: number
  longitude: number
}

function runOsmium(args: string[]) {
  const result = spawnSync('osmium', args, { stdio: 'inherit', windowsHide: true })
  if (result.error?.code === 'ENOENT') {
    throw new Error('Osmium CLI is not installed or not on PATH. Install osmium-tool, then reopen PowerShell.')
  }
  if (result.status !== 0) {
    throw new Error(`Osmium exited with status ${result.status ?? 'unknown'}.`)
  }
}

function coordinatePairs(value: unknown, pairs: [number, number][]) {
  if (!Array.isArray(value)) return
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    pairs.push([value[0], value[1]])
    return
  }
  value.forEach((child) => coordinatePairs(child, pairs))
}

function addressFrom(tags: Record<string, unknown>) {
  const address = [
    tags['addr:full'],
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] || tags['addr:barangay'],
    tags['addr:city'] || tags['addr:municipality'],
    tags['addr:province'] || tags['addr:region'],
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .filter((part, index, parts) => parts.indexOf(part) === index)
  return address.join(', ') || 'Philippines'
}

function mapFeature(feature: GeoJsonFeature): ImportedStation | null {
  const properties = feature.properties ?? {}
  const tags = typeof properties.tags === 'object' && properties.tags !== null
    ? properties.tags as Record<string, unknown>
    : properties
  const featureId = feature.id === undefined ? '' : String(feature.id)
  const osmIdMatch = featureId.match(/^([nwr])(\d+)$/)
  const osmType = osmIdMatch?.[1] === 'n' ? 'node' : osmIdMatch?.[1] === 'w' ? 'way' : osmIdMatch?.[1] === 'r' ? 'relation' : null
  const osmId = osmIdMatch?.[2] ?? properties.id
  const sourceRef = typeof properties['@id'] === 'string'
    ? properties['@id']
    : osmType && osmId !== undefined ? `${osmType}/${osmId}` : null
  if (!sourceRef) return null

  const pairs: [number, number][] = []
  coordinatePairs(feature.geometry?.coordinates, pairs)
  if (pairs.length === 0) return null

  const longitude = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
  const latitude = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  const name = typeof tags.name === 'string' && tags.name.trim()
    ? tags.name.trim()
    : typeof tags.brand === 'string' && tags.brand.trim()
      ? tags.brand.trim()
      : `Fuel station (${sourceRef})`
  const brand = typeof tags.brand === 'string' && tags.brand.trim() ? tags.brand.trim() : 'Independent'

  return { sourceRef, name, brand, address: addressFrom(tags), latitude, longitude }
}

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error('Usage: npm run db:import-osm -- <path-to-philippines.osm.pbf>')
  }

  const pbfPath = resolve(inputPath)
  await access(pbfPath)

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'lowgas-osm-'))
  const filteredPath = join(temporaryDirectory, 'fuel-stations.osm.pbf')
  const geoJsonPath = join(temporaryDirectory, 'fuel-stations.geojson')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    console.log('Filtering OSM objects tagged amenity=fuel...')
    runOsmium(['tags-filter', pbfPath, 'nwr/amenity=fuel', '-o', filteredPath, '--overwrite'])
    console.log('Converting filtered stations to GeoJSON...')
    runOsmium(['export', filteredPath, '-f', 'geojson', '-o', geoJsonPath, '--overwrite', '--add-unique-id=type_id'])

    const geoJson = JSON.parse(await readFile(geoJsonPath, 'utf8')) as { features?: GeoJsonFeature[] }
    const stations = (geoJson.features ?? []).map(mapFeature).filter((station): station is ImportedStation => station !== null)
    if (stations.length === 0) throw new Error('No usable fuel stations were found in the PBF file.')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE stations DROP CONSTRAINT IF EXISTS stations_name_key')
      await client.query('ALTER TABLE stations ADD COLUMN IF NOT EXISTS source_ref TEXT')
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS stations_source_ref_uidx ON stations (source_ref)')

      const batchSize = 500
      for (let offset = 0; offset < stations.length; offset += batchSize) {
        const batch = stations.slice(offset, offset + batchSize)
        const values: unknown[] = []
        const placeholders = batch.map((station, index) => {
          const first = index * 6
          values.push(station.sourceRef, station.name, station.brand, station.address, station.latitude, station.longitude)
          return `($${first + 1}, $${first + 2}, $${first + 3}, $${first + 4}, $${first + 5}, $${first + 6})`
        })

        await client.query(
          `INSERT INTO stations (source_ref, name, brand, address, latitude, longitude)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (source_ref) DO UPDATE SET
             name = EXCLUDED.name,
             brand = EXCLUDED.brand,
             address = EXCLUDED.address,
             latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude`,
          values,
        )
        console.log(`Imported ${Math.min(offset + batch.length, stations.length)} / ${stations.length} stations`)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    console.log(`Imported ${stations.length} OSM fuel stations. OSM does not provide live fuel prices.`)
  } finally {
    await pool.end()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})