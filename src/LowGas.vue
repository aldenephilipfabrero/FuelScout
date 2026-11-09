<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './price-watch.css'
import './profile.css'
import { Geolocation } from '@capacitor/geolocation'
import AdminPage from './admin.vue'
import UserPage from './user.vue'
import VehicleSelector from './components/VehicleSelector.vue'
import type { VehicleRecord } from './types/vehicle'
import {
  addOutline,
  businessOutline,
  createOutline,
  locateOutline,
  logOutOutline,
  navigateOutline,
  pricetagOutline,
  searchOutline,
  settingsOutline,
} from 'ionicons/icons'

type FuelPrice = { id?: number; fuelType: string; price: number; source?: 'station' | 'demo'; updatedAt?: string }
type PriceReport = { id: number; fuelType: string; price: number; createdAt: string }
type Station = { id: number; name: string; brand: string; address: string; latitude: number; longitude: number; distanceKm: number; prices: FuelPrice[]; sourceRef?: string | null; reports?: PriceReport[] }
type Account = { id: number; name: string; email: string; role: 'user' | 'station' | 'admin'; stationId?: number; searchRadiusKm?: number; vehicle: VehicleRecord | null; createdAt?: string }
type ProfileDraft = { name: string; email: string; currentPassword: string; newPassword: string; radiusKm: number }
type StationCache = { query: string; origin: { latitude: number; longitude: number }; stations: Station[]; viewMode: 'nearby' | 'nationwide'; savedAt: string }
type PriceWatchSummary = { fuel_type: string; station_count: number; average_price: number; lowest_price: number; highest_price: number; average_change: number | null; rollback_count: number; increase_count: number }
type PriceWatchRow = { station_id: number; name: string; brand: string; address: string; fuel_type: string; current_price: number; updated_at: string; previous_price: number | null; price_change: number | null; change_at: string | null }
type NationalFuelAdjustment = { fuelType: string; direction: 'increase' | 'rollback'; low: number; high: number; ytdNetChange: number | null }
type NationalFuelAdvisory = { title: string; asOf: string; effectivePeriod: string; sourceUrl: string; sourcePage: string; fetchedAt: string; adjustments: NationalFuelAdjustment[] }

function migrateLegacyStorage(): void {
  const keys = ['station-cache', 'national-price-cache', 'page', 'token', 'profile']
  for (const key of keys) {
    const currentKey = `lowgas-${key}`
    if (localStorage.getItem(currentKey) === null) {
      const legacyValue = localStorage.getItem(`fuelscout-${key}`)
      if (legacyValue !== null) localStorage.setItem(currentKey, legacyValue)
    }
  }
}

migrateLegacyStorage()

const sampleStations: Station[] = [
  { id: 1, name: 'Shell EDSA Guadalupe', brand: 'Shell', address: 'EDSA corner P. Burgos St, Makati', latitude: 14.5668, longitude: 121.0457, distanceKm: 1.2, prices: [{ fuelType: 'Unleaded', price: 63.4 }, { fuelType: 'Diesel', price: 58.8 }, { fuelType: 'Premium', price: 66.1 }] },
  { id: 2, name: 'Petron Buendia', brand: 'Petron', address: 'Gil Puyat Avenue, Makati', latitude: 14.5548, longitude: 121.0172, distanceKm: 2.6, prices: [{ fuelType: 'Unleaded', price: 62.9 }, { fuelType: 'Diesel', price: 57.9 }] },
  { id: 3, name: 'Caltex Circuit Makati', brand: 'Caltex', address: 'J.P. Rizal Ext, Makati', latitude: 14.5653, longitude: 121.0401, distanceKm: 1.7, prices: [{ fuelType: 'Unleaded', price: 64.2 }, { fuelType: 'Diesel', price: 58.1 }, { fuelType: 'Premium', price: 67.3 }] },
  { id: 4, name: 'Unioil Pioneer', brand: 'Unioil', address: 'Pioneer Street, Mandaluyong', latitude: 14.5691, longitude: 121.0561, distanceKm: 2.4, prices: [{ fuelType: 'Unleaded', price: 61.8 }, { fuelType: 'Diesel', price: 57.2 }] },
]

function readStationCache(): StationCache | null {
  try {
    const cached = localStorage.getItem('lowgas-station-cache')
    if (!cached) return null
    const parsed = JSON.parse(cached) as StationCache
    if (!Array.isArray(parsed.stations) || !Number.isFinite(parsed.origin?.latitude) || !Number.isFinite(parsed.origin?.longitude)) return null
    return parsed
  } catch {
    return null
  }
}

function readNationalPriceCache(): NationalFuelAdvisory | null {
  try {
    const cached = localStorage.getItem('lowgas-national-price-cache')
    return cached ? JSON.parse(cached) as NationalFuelAdvisory : null
  } catch {
    return null
  }
}

const startupCache = readStationCache()
const apiBase = import.meta.env.VITE_API_URL || '/api'
type AppPage = 'stations' | 'price-watch' | 'user-dashboard' | 'user-profile' | 'station-dashboard' | 'admin'
const activePage = ref<AppPage>(localStorage.getItem('lowgas-page') === 'price-watch' ? 'price-watch' : 'stations')
const stations = ref<Station[]>(startupCache?.stations ?? sampleStations)
const selected = ref<Station | null>(startupCache?.stations[0] ?? sampleStations[0]!)
const nationwideMode = ref(startupCache?.viewMode === 'nationwide')
const searchText = ref('')
const fuelFilter = ref('All fuels')
const sortMode = ref('Nearest')
const account = ref<Account | null>(null)
const token = ref(localStorage.getItem('lowgas-token'))
const apiOnline = ref(false)
const busy = ref(false)
const routeBusy = ref(false)
const mapReady = ref(false)
const origin = ref(startupCache?.origin ?? { latitude: 14.5668, longitude: 121.0457 })
const notice = ref(startupCache ? 'Restored your last station search. Refreshing station data…' : 'Showing sample stations around Makati.')
const mapElement = ref<HTMLElement | null>(null)
const settingsOpen = ref(false)
const authMode = ref<'login' | 'register'>('login')
const authRole = ref<'user' | 'station' | 'admin'>('user')
const authError = ref('')
const authSuccess = ref('')
const authName = ref('')
const authEmail = ref('')
const authPassword = ref('')
const signupVehicle = ref<VehicleRecord | null>(null)
const stationName = ref('')
const stationAddress = ref('')
const stationLatitude = ref('')
const stationLongitude = ref('')
const priceType = ref('Unleaded')
const priceValue = ref('')
const editingFuelType = ref<string | null>(null)
const profileDraft = ref<ProfileDraft>({ name: '', email: '', currentPassword: '', newPassword: '', radiusKm: 25 })
const reportOpen = ref(false)
const reportBusy = ref(false)
const reportType = ref('Unleaded')
const reportValue = ref('')
const profileBusy = ref(false)
const priceWatchBusy = ref(false)
const priceWatchFuel = ref('All fuels')
const priceWatchSummary = ref<PriceWatchSummary[]>([])
const priceWatchRows = ref<PriceWatchRow[]>([])
const lowestPriceRows = ref<PriceWatchRow[]>([])
const nationalFuelAdvisory = ref<NationalFuelAdvisory | null>(readNationalPriceCache())
const nationalAdvisoryStale = ref(!!nationalFuelAdvisory.value)
const nationalAdvisoryError = ref('')
const ownedStation = computed(() => {
  const stationId = Number(account.value?.stationId)
  return stations.value.find((station) => Number(station.id) === stationId) ?? null
})

let map: L.Map | null = null
let markerLayer: L.MarkerClusterGroup | null = null
let routeLine: L.Polyline | null = null
let currentLocationMarker: L.CircleMarker | null = null
let locationWatchId: string | null = null

function cacheStations() {
  try {
    const cache: StationCache = {
      query: searchText.value,
      origin: origin.value,
      stations: stations.value.slice(0, nationwideMode.value ? 250 : 100),
      viewMode: nationwideMode.value ? 'nationwide' : 'nearby',
      savedAt: new Date().toISOString(),
    }
    localStorage.setItem('lowgas-station-cache', JSON.stringify(cache))
  } catch {
    // Keep the live app usable if browser storage is unavailable or full.
  }
}

function targetPrice(station: Station) {
  return station.prices.find((price) => price.fuelType === (fuelFilter.value === 'All fuels' ? 'Unleaded' : fuelFilter.value))?.price ?? Number.MAX_SAFE_INTEGER
}

function money(price: number) {
  return `₱${price.toFixed(2)}`
}

function formatDate(value?: string) {
  if (!value) return 'time unavailable'
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function changeLabel(change: number | null) {
  if (change === null) return 'No previous update'
  if (change < 0) return `Rollback ${money(Math.abs(change))}`
  if (change > 0) return `Increase ${money(change)}`
  return 'No change'
}

const filteredStations = computed(() => {
  return stations.value
    .filter((station) => {
      const matchFuel = fuelFilter.value === 'All fuels' || station.prices.length === 0 || station.prices.some((price) => price.fuelType === fuelFilter.value)
      return matchFuel
    })
    .sort((a, b) => sortMode.value === 'Lowest price' ? targetPrice(a) - targetPrice(b) : a.distanceKm - b.distanceKm)
})
const visibleStations = computed(() => filteredStations.value.slice(0, 100))

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
      ...options.headers,
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.')
  return data
}

function getStoredProfile() {
  const raw = localStorage.getItem('lowgas-profile')
  if (!raw) return { name: 'Guest', email: '', password: '', radiusKm: 25 }
  try {
    const stored = JSON.parse(raw)
    if (Object.hasOwn(stored, 'password')) {
      delete stored.password
      localStorage.setItem('lowgas-profile', JSON.stringify(stored))
    }
    return { name: stored.name || 'Guest', email: stored.email || '', radiusKm: Number(stored.radiusKm || 25) }
  } catch {
    return { name: 'Guest', email: '', password: '', radiusKm: 25 }
  }
}

function saveStoredProfile() {
  localStorage.setItem('lowgas-profile', JSON.stringify({
    name: profileDraft.value.name,
    email: profileDraft.value.email,
    radiusKm: profileDraft.value.radiusKm,
  }))
}

function openProfileSettings() {
  const saved = getStoredProfile()
  profileDraft.value = {
    name: account.value?.name || saved.name || 'Guest',
    email: account.value?.email || saved.email || '',
    currentPassword: '',
    newPassword: '',
    radiusKm: Number(saved.radiusKm || 25),
  }
  settingsOpen.value = true
}

function resetTransientInputs() {
  searchText.value = ''
  authError.value = ''
  authSuccess.value = ''
  authName.value = ''
  authEmail.value = ''
  authPassword.value = ''
  stationName.value = ''
  stationAddress.value = ''
  stationLatitude.value = ''
  stationLongitude.value = ''
  signupVehicle.value = null
  priceValue.value = ''
  editingFuelType.value = null
  reportValue.value = ''
  reportOpen.value = false
  profileDraft.value = { name: '', email: '', currentPassword: '', newPassword: '', radiusKm: 25 }
}

async function saveProfileSettings() {
  const nextName = profileDraft.value.name.trim() || 'Guest'
  const nextEmail = profileDraft.value.email.trim()
  const nextRadius = Number(profileDraft.value.radiusKm) || 25

  if (!account.value) return
  profileBusy.value = true
  try {
    const payload: { name: string; email: string; searchRadiusKm: number; currentPassword?: string; newPassword?: string } = { name: nextName, email: nextEmail, searchRadiusKm: nextRadius }
    if (profileDraft.value.newPassword) {
      payload.currentPassword = profileDraft.value.currentPassword
      payload.newPassword = profileDraft.value.newPassword
    }
    const result = await request('/auth/profile', { method: 'PATCH', body: JSON.stringify(payload) })
    account.value = result.account
    token.value = result.token
    profileDraft.value.radiusKm = result.account.searchRadiusKm ?? nextRadius
    localStorage.setItem('lowgas-token', result.token)
    profileDraft.value = { name: nextName, email: nextEmail, currentPassword: '', newPassword: '', radiusKm: nextRadius }
    saveStoredProfile()
    settingsOpen.value = false
    notice.value = 'Profile saved to your account.'
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Could not save profile.'
  } finally {
    profileBusy.value = false
  }
}

async function loadPriceWatch() {
  activePage.value = 'price-watch'
  localStorage.setItem('lowgas-page', 'price-watch')
  priceWatchBusy.value = true
  try {
    const query = priceWatchFuel.value === 'All fuels' ? '' : `?fuelType=${encodeURIComponent(priceWatchFuel.value)}`
    const [stationResult, nationalResult] = await Promise.allSettled([
      request(`/price-watch${query}`),
      request('/national-price-watch'),
    ])

    if (stationResult.status === 'fulfilled') {
      priceWatchSummary.value = stationResult.value.summary
      priceWatchRows.value = stationResult.value.prices
      lowestPriceRows.value = stationResult.value.lowestPrices
    } else {
      notice.value = stationResult.reason instanceof Error ? stationResult.reason.message : 'Could not load registered station prices.'
    }

    if (nationalResult.status === 'fulfilled') {
      nationalFuelAdvisory.value = nationalResult.value
      nationalAdvisoryStale.value = false
      nationalAdvisoryError.value = ''
      localStorage.setItem('lowgas-national-price-cache', JSON.stringify(nationalResult.value))
    } else {
      nationalAdvisoryStale.value = !!nationalFuelAdvisory.value
      nationalAdvisoryError.value = nationalResult.reason instanceof Error ? nationalResult.reason.message : 'DOE data is temporarily unavailable.'
    }
  } finally {
    priceWatchBusy.value = false
  }
}

async function openPriceStation(row: PriceWatchRow) {
  busy.value = true
  try {
    const result = await request(`/stations/${row.station_id}?lat=${origin.value.latitude}&lng=${origin.value.longitude}`)
    const station = result.station as Station
    stations.value = [station, ...stations.value.filter((item) => item.id !== station.id)]
    selected.value = station
    nationwideMode.value = false
    activePage.value = 'stations'
    await nextTick()
    map?.invalidateSize()
    map?.flyTo([station.latitude, station.longitude], Math.max(map.getZoom(), 15), { duration: 0.7 })
    updateMap()
    notice.value = `Showing ${station.name}, the lowest listed ${row.fuel_type} price at ${money(row.current_price)} per liter.`
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Could not open this station on the map.'
  } finally {
    busy.value = false
  }
}

async function showStations() {
  activePage.value = 'stations'
  localStorage.setItem('lowgas-page', 'stations')
  if (stations.value.length === 0) {
    if (nationwideMode.value) await loadNationwide()
    else await loadNearby(origin.value.latitude, origin.value.longitude, Number(profileDraft.value.radiusKm || 25))
  }
}

async function searchLocation() {
  nationwideMode.value = false
  const query = searchText.value.trim()
  if (!query) {
    await loadNearby(origin.value.latitude, origin.value.longitude, Number(profileDraft.value.radiusKm || 25))
    return
  }

  try {
    const geoUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=ph&limit=1`
    const response = await fetch(geoUrl, {
      headers: { Accept: 'application/json' },
    })
    const results = await response.json()
    if (!results || !results[0]) {
      notice.value = 'Location not found. Try a city, municipality, or province in the Philippines.'
      return
    }
    const lat = Number(results[0].lat)
    const lon = Number(results[0].lon)
    origin.value = { latitude: lat, longitude: lon }
    map?.flyTo([lat, lon], 12, { duration: 0.8 })
    await loadNearby(lat, lon, Number(profileDraft.value.radiusKm || 25))
    notice.value = `Showing fuel stations around ${results[0].display_name || query}.`
  } catch {
    notice.value = 'Location search is unavailable right now. Please try again later.'
  }
}

async function fetchOverpassStations(latitude: number, longitude: number, radiusKm = 25) {
  try {
    const radiusMeters = Math.max(1500, Math.min(radiusKm * 1000, 50000))
    const query = `
      [out:json][timeout:25];
      (
        node["amenity"="fuel"](around:${radiusMeters},${latitude},${longitude});
        way["amenity"="fuel"](around:${radiusMeters},${latitude},${longitude});
        relation["amenity"="fuel"](around:${radiusMeters},${latitude},${longitude});
      );
      out center;
    `

    const response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`)
    if (!response.ok) throw new Error(`OpenStreetMap query failed (${response.status}).`)
    const data = await response.json()

    if (!data || !data.elements || !data.elements.length) {
      stations.value = []
      selected.value = null
      localStorage.removeItem('lowgas-station-cache')
      notice.value = 'No mapped fuel stations found within this search radius.'
      apiOnline.value = false
      updateMap()
      return
    }

    const mappedStations: Station[] = data.elements.map((el: any, index: number) => {
      const lat = typeof el.lat === 'number' ? el.lat : Number(el.center?.lat)
      const lon = typeof el.lon === 'number' ? el.lon : Number(el.center?.lon)
      const name = el.tags?.name || el.tags?.brand || `Station ${index + 1}`
      const brand = el.tags?.brand || 'Independent'
      const address = el.tags?.['addr:street'] || el.tags?.['addr:city'] || 'Philippines'
      const dLat = lat - latitude
      const dLon = lon - longitude
      const distanceKm = Math.sqrt(dLat * dLat + dLon * dLon) * 111

      return {
        id: Number(el.id) || index + 1000,
        name,
        brand,
        address,
        latitude: lat,
        longitude: lon,
        distanceKm: Number(distanceKm.toFixed(1)),
        prices: [],
      }
    })

    stations.value = mappedStations.sort((a, b) => a.distanceKm - b.distanceKm)
    selected.value = stations.value[0]
    cacheStations()
    notice.value = `${stations.value.length} stations loaded from OpenStreetMap around your selected area.`
    apiOnline.value = true
    updateMap()
  } catch {
    const cached = readStationCache()
    const sameArea = cached && Math.abs(cached.origin.latitude - latitude) < 0.01 && Math.abs(cached.origin.longitude - longitude) < 0.01
    if (sameArea && cached.stations.length) {
      stations.value = cached.stations
      selected.value = cached.stations[0] ?? null
      notice.value = `Could not refresh. Showing ${cached.stations.length} saved stations from your last search.`
    } else {
      notice.value = 'Station lookup is temporarily unavailable. Please try again later.'
      stations.value = []
      selected.value = null
    }
    apiOnline.value = false
    updateMap()
  }
}

async function loadNearby(latitude = 14.5668, longitude = 121.0457, radiusKm = 25) {
  nationwideMode.value = false
  try {
    const result = await request(`/stations?lat=${latitude}&lng=${longitude}&radiusKm=${radiusKm}`)
    if (result && result.stations && result.stations.length) {
      stations.value = result.stations
      selected.value = result.stations[0]
      cacheStations()
      apiOnline.value = true
      notice.value = `${result.stations.length} stations found in your search radius.`
    } else {
      await fetchOverpassStations(latitude, longitude, radiusKm)
    }
  } catch {
    apiOnline.value = false
    await fetchOverpassStations(latitude, longitude, radiusKm)
  }

  await nextTick()
  updateMap()
}

async function loadNationwide() {
  busy.value = true
  nationwideMode.value = true
  try {
    const result = await request(`/stations?nationwide=true&lat=${origin.value.latitude}&lng=${origin.value.longitude}`)
    stations.value = result.stations
    selected.value = result.stations[0] ?? null
    apiOnline.value = true
    cacheStations()
    notice.value = `${result.stations.length.toLocaleString()} station locations loaded across the Philippines.`
    await nextTick()
    updateMap()
    if (map && result.stations.length) {
      const bounds = L.latLngBounds(result.stations.map((station: Station) => [station.latitude, station.longitude]))
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 7 })
    }
  } catch (error) {
    apiOnline.value = false
    notice.value = error instanceof Error ? error.message : 'Could not load nationwide station locations.'
  } finally {
    busy.value = false
  }
}

async function locateMe() {
  nationwideMode.value = false
  busy.value = true
  try {
    const { latitude, longitude } = (await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000 })).coords
    origin.value = { latitude, longitude }
    startLiveLocation()
    map?.flyTo([latitude, longitude], 14, { duration: 0.7 })
    await loadNearby(latitude, longitude, Number(profileDraft.value.radiusKm || 25))
  } catch (error) {
    notice.value = error instanceof Error
      ? `Location is unavailable: ${error.message}. Check device location settings or permission, or choose a station on the map.`
      : 'Location is unavailable. Check device location settings or permission, or choose a station on the map.'
  } finally {
    busy.value = false
  }
}

function updateDistances(latitude: number, longitude: number) {
  origin.value = { latitude, longitude }
  if (map) {
    if (!currentLocationMarker) {
      currentLocationMarker = L.circleMarker([latitude, longitude], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#2878d0',
        fillOpacity: 1,
      }).addTo(map)
    } else {
      currentLocationMarker.setLatLng([latitude, longitude])
    }
    currentLocationMarker.bindTooltip('Your current location')
  }
  const radians = (degrees: number) => degrees * Math.PI / 180
  stations.value = stations.value.map((station) => {
    const dLat = radians(station.latitude - latitude)
    const dLon = radians(station.longitude - longitude)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latitude)) * Math.cos(radians(station.latitude)) * Math.sin(dLon / 2) ** 2
    const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return { ...station, distanceKm: Number(distanceKm.toFixed(1)) }
  })
  selected.value = stations.value.find((station) => station.id === selected.value?.id) ?? selected.value
}

function startLiveLocation() {
  if (locationWatchId) return
  void Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }, (position, error) => {
    if (error) {
      notice.value = `Live location stopped: ${error.message}`
      return
    }
    if (!position) return
    updateDistances(position.coords.latitude, position.coords.longitude)
  }).then((watchId) => {
    locationWatchId = watchId
  }).catch((error: unknown) => {
    notice.value = error instanceof Error ? error.message : 'Could not start live location updates.'
  })
}

function makeMarker(station: Station) {
  const price = station.prices.find((item) => item.fuelType === (fuelFilter.value === 'All fuels' ? 'Unleaded' : fuelFilter.value))?.price
  return L.divIcon({
    className: 'station-pin-wrap',
    html: `<div class="station-pin"><span>${price === undefined ? 'Fuel' : `₱${price.toFixed(0)}`}</span></div>`,
    iconSize: [58, 42],
    iconAnchor: [29, 42],
  })
}

function updateMap() {
  if (!map || !markerLayer) return
  markerLayer.clearLayers()
  filteredStations.value.forEach((station) => {
    L.marker([station.latitude, station.longitude], { icon: makeMarker(station) })
      .addTo(markerLayer!)
      .on('click', () => selectStation(station))
  })
}

function selectStation(station: Station) {
  selected.value = station
  map?.flyTo([station.latitude, station.longitude], Math.max(map.getZoom(), 14), { duration: 0.55 })
}

async function showRoute() {
  const station = selected.value
  if (!map || !station) return
  routeBusy.value = true
  notice.value = 'Getting your current location for directions…'
  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    })
    const { latitude, longitude } = position.coords
    updateDistances(latitude, longitude)
    startLiveLocation()
    const result = await request(`/route?fromLat=${latitude}&fromLng=${longitude}&toLat=${station.latitude}&toLng=${station.longitude}`)
    const coords = result.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]]) as [number, number][]
    if (routeLine) routeLine.remove()
    routeLine = L.polyline(coords, { color: '#e56845', weight: 5, opacity: 0.88 }).addTo(map)
    map.fitBounds(routeLine.getBounds(), { padding: [40, 40] })
    notice.value = `Route from your current location to ${station.name} · ${Number(result.distanceKm).toFixed(1)} km · about ${Math.round(Number(result.durationMinutes))} min.`
    if (account.value?.role === 'user' && account.value.vehicle) {
      const { vehicle } = account.value
      const fuelLiters = Number(result.distanceKm) / vehicle.fuelEconomyKmL
      notice.value += ` Estimated fuel: ${fuelLiters.toFixed(2)} L (${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.category}, ${vehicle.fuelEconomyKmL.toFixed(2)} km/L; ${vehicle.economySource}; one way).`
    } else if (account.value?.role === 'user') {
      notice.value += ' Add a catalog vehicle in My profile to estimate fuel use.'
    }
  } catch (error) {
    notice.value = error instanceof Error
      ? `Could not get directions from your current location: ${error.message}`
      : 'Could not get directions from your current location. Allow location access and try again.'
  } finally {
    routeBusy.value = false
  }
}

async function submitAuth() {
  busy.value = true
  authError.value = ''
  authSuccess.value = ''
  try {
    const path = authMode.value === 'login' ? '/auth/login' : '/auth/register'
    const payload = authMode.value === 'login'
      ? { email: authEmail.value, password: authPassword.value, accountType: authRole.value }
      : {
          name: authName.value,
          email: authEmail.value,
          password: authPassword.value,
          role: authRole.value,
          vehicle: authRole.value === 'user' ? signupVehicle.value : undefined,
          stationName: stationName.value,
          address: stationAddress.value,
          latitude: Number(stationLatitude.value),
          longitude: Number(stationLongitude.value),
        }

    const result = await request(path, { method: 'POST', body: JSON.stringify(payload) })
    if (result.applicationPending) {
      resetTransientInputs()
      authMode.value = 'login'
      authRole.value = 'station'
      authSuccess.value = result.message || 'Your station application was submitted for administrator review.'
      return
    }
    if (
      typeof result.token !== 'string' ||
      typeof result.account?.name !== 'string' ||
      typeof result.account?.email !== 'string'
    ) {
      throw new Error('The server did not return a valid account session. If you were registering, try signing in in case your account was created.')
    }

    token.value = result.token
    account.value = result.account
    localStorage.setItem('lowgas-token', result.token)
    profileDraft.value.name = result.account.name
    profileDraft.value.email = result.account.email
    profileDraft.value.radiusKm = result.account.searchRadiusKm ?? 25
    saveStoredProfile()
    notice.value = `Signed in as ${result.account.name}`
    await loadCurrentAccount()
    if (account.value) await initializeAuthenticatedApp()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : 'Could not sign in.'
  } finally {
    busy.value = false
  }
}

async function loadCurrentAccount() {
  try {
    const result = await request('/auth/me')
    account.value = result.account
    profileDraft.value.radiusKm = result.account.searchRadiusKm ?? 25
    if (result.station) {
      const existing = stations.value.find((station) => station.id === result.station.id)
      if (existing) selected.value = existing
      else {
        stations.value = [result.station, ...stations.value]
        selected.value = result.station
      }
    }
    activePage.value = result.account.role === 'admin' ? 'admin' : result.account.role === 'user' ? 'user-dashboard' : 'station-dashboard'
  } catch {
    authError.value = 'Your session expired. Please sign in again.'
    signOut()
  }
}

function showUserPage(page: 'user-dashboard' | 'user-profile') {
  activePage.value = page
}

function updateUserAccount(payload: { account: Account; token: string }) {
  account.value = payload.account
  token.value = payload.token
  profileDraft.value.name = payload.account.name
  profileDraft.value.email = payload.account.email
  profileDraft.value.radiusKm = payload.account.searchRadiusKm ?? profileDraft.value.radiusKm
}

function toggleAuthMode() {
  resetTransientInputs()
  authMode.value = authMode.value === 'login' ? 'register' : 'login'
  authError.value = ''
  if (authMode.value === 'register' && authRole.value === 'admin') authRole.value = 'user'
}

function chooseAuthRole(role: 'user' | 'station' | 'admin') {
  resetTransientInputs()
  authRole.value = role
  authError.value = ''
}

function openOwnedStation() {
  const station = ownedStation.value
  if (!station) {
    notice.value = 'Your station listing could not be found. Please sign in again or contact an administrator.'
    return
  }
  selected.value = station
  activePage.value = 'stations'
  void nextTick(() => {
    map?.invalidateSize()
    map?.setView([station.latitude, station.longitude], 15, { animate: true })
    updateMap()
  })
}

function manageOwnedPrice(price?: FuelPrice) {
  const station = ownedStation.value
  if (!station) {
    notice.value = 'Your station listing could not be found. Please sign in again or contact an administrator.'
    return
  }
  selected.value = station
  if (price) editPrice(price)
  activePage.value = 'stations'
  void nextTick(() => {
    map?.invalidateSize()
    map?.setView([station.latitude, station.longitude], 15, { animate: true })
    updateMap()
  })
}

async function claimStation() {
  const station = selected.value
  if (!station || !account.value || account.value.role !== 'station') return
  busy.value = true
  try {
    const result = await request(`/stations/${station.id}/claim`, { method: 'POST' })
    token.value = result.token
    account.value = result.account
    localStorage.setItem('lowgas-token', result.token)
    selected.value = result.station
    stations.value = stations.value.map((item) => item.id === station.id ? result.station : item)
    notice.value = `${station.name} is now linked to your station-owner account.`
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Could not claim this station.'
  } finally {
    busy.value = false
  }
}

async function submitPriceReport() {
  const station = selected.value
  if (!station || !account.value || !reportValue.value) return
  reportBusy.value = true
  try {
    const result = await request(`/stations/${station.id}/reports`, {
      method: 'POST',
      body: JSON.stringify({ fuelType: reportType.value, price: Number(reportValue.value) }),
    })
    const nextStation = { ...station, reports: [result.report, ...(station.reports ?? [])].slice(0, 12) }
    selected.value = nextStation
    stations.value = stations.value.map((item) => item.id === station.id ? nextStation : item)
    reportValue.value = ''
    reportOpen.value = false
    cacheStations()
    notice.value = 'Community report submitted and marked unverified.'
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Could not submit the report.'
  } finally {
    reportBusy.value = false
  }
}

function openPriceReport() {
  if (!account.value) return
  reportOpen.value = !reportOpen.value
}

function signOut() {
  if (locationWatchId) {
    void Geolocation.clearWatch({ id: locationWatchId })
    locationWatchId = null
  }
  map?.remove()
  map = null
  markerLayer = null
  routeLine = null
  currentLocationMarker = null
  mapReady.value = false
  token.value = null
  account.value = null
  localStorage.removeItem('lowgas-token')
  activePage.value = 'stations'
  settingsOpen.value = false
  resetTransientInputs()
  authMode.value = 'login'
  authRole.value = 'user'
  notice.value = 'Signed out.'
}

async function savePrice() {
  const station = selected.value
  if (!station || !priceValue.value) return
  try {
    const path = editingFuelType.value
      ? `/stations/${station.id}/prices/${encodeURIComponent(editingFuelType.value)}`
      : `/stations/${station.id}/prices`

    const result = await request(path, {
      method: editingFuelType.value ? 'PUT' : 'POST',
      body: JSON.stringify({ fuelType: priceType.value, price: Number(priceValue.value) }),
    })

    selected.value = { ...station, prices: result.prices }
    stations.value = stations.value.map((item) => item.id === station.id ? selected.value! : item)
    priceValue.value = ''
    editingFuelType.value = null
    notice.value = 'Fuel price saved.'
    updateMap()
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Could not save price.'
  }
}

function editPrice(price: FuelPrice) {
  editingFuelType.value = price.fuelType
  priceType.value = price.fuelType
  priceValue.value = price.price.toFixed(2)
}

async function deletePrice(price: FuelPrice) {
  const station = selected.value
  if (!station || !price.id) return
  try {
    const result = await request(`/stations/${station.id}/prices/${price.id}`, { method: 'DELETE' })
    selected.value = { ...station, prices: result.prices }
    stations.value = stations.value.map((item) => item.id === station.id ? selected.value! : item)
    notice.value = 'Fuel price removed.'
    updateMap()
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Could not remove price.'
  }
}

watch(filteredStations, updateMap, { deep: true })
watch(activePage, async (page) => {
  if (page === 'stations') {
    await nextTick()
    map?.invalidateSize()
  }
})

async function initializeAuthenticatedApp() {
  await nextTick()

  if (mapElement.value && !map) {
    map = L.map(mapElement.value, { zoomControl: false }).setView([origin.value.latitude, origin.value.longitude], nationwideMode.value ? 6 : startupCache ? 12 : 14)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    markerLayer = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 48 }).addTo(map)
    mapReady.value = true
    updateMap()
  }

  const saved = getStoredProfile()
  if (saved.radiusKm) profileDraft.value.radiusKm = Number(saved.radiusKm)

  if (activePage.value === 'price-watch') await loadPriceWatch()
  else if (nationwideMode.value) await loadNationwide()
  else await loadNearby(origin.value.latitude, origin.value.longitude, Number(profileDraft.value.radiusKm || 25))
}

onMounted(async () => {
  resetTransientInputs()
  const saved = getStoredProfile()
  if (saved.radiusKm) profileDraft.value.radiusKm = Number(saved.radiusKm)
  if (!token.value) return
  await loadCurrentAccount()
  if (account.value) await initializeAuthenticatedApp()
})

onBeforeUnmount(() => {
  if (locationWatchId) void Geolocation.clearWatch({ id: locationWatchId })
  map?.remove()
})
</script>

<template>
  <ion-app>
    <div v-if="account" class="app-shell">
      <aside class="rail">
        <a class="brand" href="#" aria-label="LowGas home"><span class="brand-mark">L</span><span>Low<span class="brand-light">Gas</span></span></a>
        <div class="rail-caption">DISCOVER</div>
        <button :class="['rail-link', { active: activePage === 'stations' }]" @click="showStations"><ion-icon :icon="searchOutline" /><span>Find fuel</span></button>
        <button :class="['rail-link', { active: activePage === 'price-watch' }]" @click="loadPriceWatch"><ion-icon :icon="pricetagOutline" /><span>Price watch</span></button>
        <template v-if="account?.role === 'station'">
          <div class="rail-caption">STATION</div>
          <button :class="['rail-link', { active: activePage === 'station-dashboard' }]" @click="activePage = 'station-dashboard'"><ion-icon :icon="businessOutline" /><span>My station</span></button>
        </template>
        <template v-if="account?.role === 'user'">
          <div class="rail-caption">ACCOUNT</div>
          <button :class="['rail-link', { active: activePage === 'user-dashboard' }]" @click="showUserPage('user-dashboard')"><ion-icon :icon="settingsOutline" /><span>Dashboard</span></button>
          <button :class="['rail-link', { active: activePage === 'user-profile' }]" @click="showUserPage('user-profile')"><ion-icon :icon="settingsOutline" /><span>My profile</span></button>
        </template>
        <template v-if="account?.role === 'admin'">
          <div class="rail-caption">ADMIN</div>
          <button :class="['rail-link', { active: activePage === 'admin' }]" @click="activePage = 'admin'"><ion-icon :icon="settingsOutline" /><span>Admin dashboard</span></button>
        </template>
        <div class="rail-bottom">
          <button v-if="account" class="rail-link" @click="signOut"><ion-icon :icon="logOutOutline" /><span>Sign out</span></button>
          <div class="rail-avatar">{{ account?.name?.charAt(0).toUpperCase() || 'G' }}</div>
        </div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div>
            <div class="eyebrow">YOUR LOCAL FUEL GUIDE</div>
            <h1>{{ activePage === 'admin' ? 'System administration' : activePage === 'user-dashboard' || activePage === 'user-profile' ? 'Your LowGas account' : activePage === 'station-dashboard' ? 'Station owner dashboard' : 'Find fuel that goes further.' }}</h1>
          </div>
          <div class="top-actions">
            <div class="live-status"><span :class="['status-dot', { online: apiOnline }]" ></span>{{ apiOnline ? 'Station data available' : 'Station data limited' }}</div>
            <button v-if="account" class="account-button" @click="account.role === 'user' ? showUserPage('user-profile') : openProfileSettings()"><span class="user-initial">{{ account.name.charAt(0).toUpperCase() }}</span>{{ account.name }}<ion-icon :icon="settingsOutline" /></button>
          </div>
        </header>

        <AdminPage v-if="activePage === 'admin' && account?.role === 'admin'" :token="token || ''" />
        <UserPage
          v-else-if="(activePage === 'user-dashboard' || activePage === 'user-profile') && account?.role === 'user'"
          :key="activePage"
          :account="account"
          :token="token || ''"
          :start-tab="activePage === 'user-profile' ? 'profile' : 'overview'"
          @account-updated="updateUserAccount"
          @navigate="(page) => page === 'stations' ? showStations() : loadPriceWatch()"
        />
        <section v-else-if="activePage === 'station-dashboard' && account?.role === 'station'" class="station-owner-page">
          <header class="station-owner-heading">
            <div>
              <div class="eyebrow">STATION OWNER WORKSPACE</div>
              <h2>Welcome, {{ account.name }}</h2>
              <p>Manage your public listing and keep customers’ fuel prices up to date.</p>
            </div>
            <button class="station-owner-settings" @click="openProfileSettings"><ion-icon :icon="settingsOutline" /> Account settings</button>
          </header>
          <section class="station-owner-hero">
            <div class="station-owner-hero-icon"><ion-icon :icon="businessOutline" /></div>
            <div class="station-owner-hero-copy">
              <span class="eyebrow">YOUR PUBLIC LISTING</span>
              <h3>{{ ownedStation?.name || 'Station listing unavailable' }}</h3>
              <p>{{ ownedStation?.address || 'Please sign in again or contact an administrator to check your station record.' }}</p>
            </div>
            <span :class="['station-owner-status', { 'is-unavailable': !ownedStation }]">{{ ownedStation ? 'LISTING ACTIVE' : 'NEEDS ATTENTION' }}</span>
          </section>
          <div class="station-owner-stats">
            <article><span>Fuel types listed</span><strong>{{ ownedStation?.prices.length ?? 0 }}</strong><small>Prices customers can compare</small></article>
            <article><span>Listing status</span><strong>{{ ownedStation ? 'Active' : 'Unavailable' }}</strong><small>{{ ownedStation ? 'Visible on the station map' : 'Check your station account' }}</small></article>
            <article><span>Account role</span><strong>Station owner</strong><small>Manage only your linked station</small></article>
          </div>
          <div class="station-owner-grid">
            <article class="station-owner-card">
              <div class="station-owner-card-heading"><div><span class="eyebrow">BUSINESS PROFILE</span><h3>Station details</h3></div><ion-icon :icon="businessOutline" /></div>
              <dl>
                <div><dt>Owner</dt><dd>{{ account.name }}</dd></div>
                <div><dt>Email</dt><dd>{{ account.email }}</dd></div>
                <div><dt>Station</dt><dd>{{ ownedStation?.name || 'Not linked' }}</dd></div>
                <div><dt>Brand</dt><dd>{{ ownedStation?.brand || '—' }}</dd></div>
                <div><dt>Address</dt><dd>{{ ownedStation?.address || '—' }}</dd></div>
              </dl>
              <button class="station-owner-primary" :disabled="!ownedStation" @click="openOwnedStation"><ion-icon :icon="searchOutline" /> View station on map</button>
            </article>
            <article class="station-owner-card">
              <div class="station-owner-card-heading"><div><span class="eyebrow">CUSTOMER PRICING</span><h3>Current fuel prices</h3></div><ion-icon :icon="pricetagOutline" /></div>
              <div v-if="ownedStation?.prices.length" class="station-owner-prices">
                <div v-for="price in ownedStation.prices" :key="price.fuelType" class="station-owner-price-row">
                  <span><strong>{{ price.fuelType }}</strong><small>Updated {{ formatDate(price.updatedAt) }}</small></span>
                  <strong>{{ money(price.price) }}<small> / liter</small></strong>
                  <button :aria-label="`Edit ${price.fuelType} price`" @click="manageOwnedPrice(price)"><ion-icon :icon="createOutline" /> Edit</button>
                </div>
              </div>
              <div v-else class="station-owner-empty"><ion-icon :icon="pricetagOutline" /><p>No owner-managed prices yet.</p><small>Add prices so drivers can compare your station.</small></div>
              <button class="station-owner-primary" :disabled="!ownedStation" @click="manageOwnedPrice()"><ion-icon :icon="createOutline" /> Manage prices</button>
            </article>
          </div>
        </section>

        <section v-show="activePage === 'stations'" class="search-strip">
          <label class="search-box">
            <ion-icon :icon="searchOutline" />
            <input v-model="searchText" autocomplete="off" placeholder="Search city, municipality, or province" aria-label="Search location" />
          </label>
          <button class="location-button" :disabled="busy" @click="searchLocation">
            <ion-icon :icon="locateOutline" />{{ busy ? 'Searching…' : 'Search' }}
          </button>
          <label class="select-wrap"><span>FUEL</span>
            <select v-model="fuelFilter"><option>All fuels</option><option>Unleaded</option><option>Diesel</option><option>Premium</option></select>
          </label>
          <label class="select-wrap"><span>SORT BY</span>
            <select v-model="sortMode"><option>Nearest</option><option>Lowest price</option></select>
          </label>
          <button class="location-button" :disabled="busy" @click="locateMe">
            <ion-icon :icon="locateOutline" />{{ busy ? 'Locating…' : 'Near me' }}
          </button>
          <button class="location-button" :class="{ active: nationwideMode }" :disabled="busy" @click="loadNationwide">
            {{ busy && nationwideMode ? 'Loading…' : 'Pilipinas' }}
          </button>
        </section>

        <section v-show="activePage === 'stations'" class="content-grid">
          <div class="map-panel">
            <div ref="mapElement" class="map" aria-label="Map of nearby gas stations"></div>
            <div class="map-label"><span class="map-label-dot"></span> PHILIPPINES <span class="map-label-divider">/</span> {{ filteredStations.length }} STATIONS</div>
            <div class="map-note"><span class="map-legend-pin"></span> Fuel price <span class="map-note-divider"></span> Map data © OpenStreetMap</div>
          </div>

          <aside class="results-panel">
            <div class="results-heading">
              <div>
                <div class="eyebrow">AROUND YOU</div>
                <h2>{{ nationwideMode ? 'Philippines stations' : 'Nearby stations' }}</h2>
              </div>
              <span class="result-count">{{ filteredStations.length }}</span>
            </div>
            <p class="notice-line" :class="{ 'notice-live': apiOnline }">{{ notice }}</p>

            <div class="station-list">
              <button v-for="station in visibleStations" :key="station.id" class="station-row" :class="{ selected: selected?.id === station.id }" @click="selectStation(station)">
                <span class="station-brand" :class="`brand-${station.brand.toLowerCase()}`">{{ station.brand.slice(0, 1) }}</span>
                <span class="station-summary">
                  <strong>{{ station.name }}</strong>
                  <small>{{ station.distanceKm.toFixed(1) }} km · {{ station.address }}</small>
                  <span v-if="station.prices.length" class="mini-prices">
                    <span v-for="price in station.prices.slice(0, 2)" :key="price.fuelType">{{ price.fuelType }} <b>{{ money(price.price) }}</b></span>
                  </span>
                  <span v-else-if="station.reports?.length" class="mini-prices">Reported {{ station.reports[0].fuelType }} {{ money(station.reports[0].price) }} · unverified</span>
                  <span v-else class="mini-prices">Prices not listed</span>
                </span>
                <span class="row-chevron">›</span>
              </button>
              <div v-if="filteredStations.length > visibleStations.length" class="empty-results">Showing first 100 of {{ filteredStations.length.toLocaleString() }} stations. Zoom in on the map to explore clusters.</div>
              <div v-if="filteredStations.length === 0" class="empty-results">No stations match those filters.</div>
            </div>

            <div v-if="selected" class="detail-panel">
              <div class="detail-top">
                <div>
                  <span class="detail-kicker">STATION DETAILS</span>
                  <h3>{{ selected.name }}</h3>
                  <p>{{ selected.address }}</p>
                </div>
                <span class="verified-mark">✓</span>
              </div>

              <div class="distance-line">
                <span>{{ selected.distanceKm.toFixed(1) }} km away</span>
                <button class="directions-button" :disabled="routeBusy" @click="showRoute">
                  <ion-icon :icon="navigateOutline" />{{ routeBusy ? 'Getting location…' : 'Directions from me' }}
                </button>
              </div>

              <div class="price-heading"><span>FUEL TYPE</span><span>PRICE / L</span></div>
              <div v-for="price in selected.prices" :key="price.fuelType" class="price-row">
                <span>{{ price.fuelType }}</span>
                <strong>{{ money(price.price) }}</strong>
                <button v-if="account?.role === 'station' && Number(account.stationId) === Number(selected.id)" class="edit-price" aria-label="Edit price" @click.stop="editPrice(price)"><ion-icon :icon="createOutline" /></button>
                <button v-if="account?.role === 'station' && Number(account.stationId) === Number(selected.id)" class="delete-price" aria-label="Delete price" @click="deletePrice(price)">×</button>
              </div>
              <p v-for="price in selected.prices" :key="`${price.fuelType}-updated`" class="price-footnote">Station price · updated {{ formatDate(price.updatedAt) }}</p>
              <p v-if="selected.prices.length === 0" class="price-footnote">No fuel prices are available for this station.</p>

              <div v-if="selected.reports?.length" class="community-reports">
                <div class="price-heading"><span>COMMUNITY REPORTS · UNVERIFIED</span><span>PRICE / L</span></div>
                <div v-for="report in selected.reports" :key="report.id" class="price-row">
                  <span>{{ report.fuelType }}<small class="price-footnote">Reported {{ formatDate(report.createdAt) }}</small></span>
                  <strong>{{ money(report.price) }}</strong>
                </div>
              </div>

              <form v-if="account?.role === 'station' && Number(account.stationId) === Number(selected.id)" class="price-editor" autocomplete="off" @submit.prevent="savePrice">
                <select v-model="priceType" :disabled="!!editingFuelType" aria-label="Fuel type">
                  <option>Unleaded</option>
                  <option>Diesel</option>
                  <option>Premium</option>
                </select>
                <input v-model="priceValue" type="number" min="0.01" step="0.01" placeholder="Price per liter" aria-label="Price per liter" required />
                <button type="submit" :aria-label="editingFuelType ? 'Save price' : 'Add price'"><ion-icon :icon="editingFuelType ? createOutline : addOutline" /></button>
                <button v-if="editingFuelType" type="button" class="cancel-edit" aria-label="Cancel edit" @click="editingFuelType = null; priceValue = ''">×</button>
              </form>

              <button v-if="account?.role === 'station' && Number(account.stationId) !== Number(selected.id) && selected.sourceRef && !selected.sourceRef.startsWith('sample:')" class="directions-button" :disabled="busy" @click="claimStation">{{ busy ? 'Claiming…' : 'Claim this station' }}</button>
              <button class="directions-button" @click="openPriceReport">{{ reportOpen ? 'Cancel report' : 'Report a price' }}</button>
              <form v-if="reportOpen" class="price-editor" autocomplete="off" @submit.prevent="submitPriceReport">
                <select v-model="reportType" aria-label="Reported fuel type">
                  <option>Unleaded</option>
                  <option>Diesel</option>
                  <option>Premium</option>
                </select>
                <input v-model="reportValue" type="number" min="0.01" max="1000" step="0.01" placeholder="Observed price per liter" aria-label="Observed price per liter" required />
                <button type="submit" :disabled="reportBusy" aria-label="Submit unverified community report">{{ reportBusy ? '…' : 'Send' }}</button>
              </form>

              <div class="price-footnote"><span class="freshness-dot"></span>Station prices are owner-managed; community reports are unverified.</div>
            </div>

          </aside>
        </section>

        <section v-if="activePage === 'price-watch'" class="price-watch-page">
          <div class="price-watch-heading">
            <div>
              <div class="eyebrow">DOE NATIONAL ADVISORY + REGISTERED STATIONS</div>
              <h2>Price Watch</h2>
              <p>National weekly adjustments and registered-station prices use separate sources and are shown in separate sections.</p>
            </div>
            <div class="price-watch-actions">
              <label class="select-wrap"><span>FUEL TYPE</span>
                <select v-model="priceWatchFuel" @change="loadPriceWatch"><option>All fuels</option><option>Unleaded</option><option>Diesel</option><option>Premium</option></select>
              </label>
              <button class="location-button" :disabled="priceWatchBusy" @click="loadPriceWatch">{{ priceWatchBusy ? 'Refreshing…' : 'Refresh' }}</button>
            </div>
          </div>

          <section class="national-advisory">
            <div class="national-advisory-heading">
              <div>
                <span class="eyebrow">NATIONAL REFERENCE · DEPARTMENT OF ENERGY</span>
                <h3>DOE weekly fuel-price adjustment</h3>
                <p v-if="nationalFuelAdvisory">As of {{ nationalFuelAdvisory.asOf }} · effective {{ nationalFuelAdvisory.effectivePeriod }}</p>
                <p v-else>{{ nationalAdvisoryError || 'Loading the latest DOE advisory…' }}</p>
              </div>
              <a v-if="nationalFuelAdvisory" class="doe-source-link" :href="nationalFuelAdvisory.sourceUrl" target="_blank" rel="noreferrer">Open DOE source ↗</a>
            </div>
            <p v-if="nationalFuelAdvisory" class="national-advisory-note">These are nationwide weekly price adjustments, not absolute pump prices. {{ nationalAdvisoryStale ? 'Showing the last saved DOE report because the live source could not refresh.' : 'Prices may differ by station and region.' }}</p>
            <p v-else class="national-advisory-note">{{ nationalAdvisoryError }}. Check the <a href="https://doe.gov.ph/data-and-prices/liquid-fuels/oil-monitor" target="_blank" rel="noreferrer">DOE Oil Monitor</a>.</p>
            <div v-if="nationalFuelAdvisory" class="national-adjustment-grid">
              <article v-for="adjustment in nationalFuelAdvisory.adjustments" :key="adjustment.fuelType" class="national-adjustment-item">
                <span class="watch-fuel-label">{{ adjustment.fuelType }}</span>
                <strong :class="adjustment.direction === 'rollback' ? 'rollback' : 'increase'">{{ adjustment.direction === 'rollback' ? 'Rollback' : 'Increase' }} {{ adjustment.low === adjustment.high ? money(adjustment.low) : `${money(adjustment.low)}–${money(adjustment.high)}` }}<small>/L</small></strong>
                <small>YTD net {{ adjustment.ytdNetChange === null ? 'not stated' : `${money(adjustment.ytdNetChange)}/L` }}</small>
              </article>
            </div>
          </section>

          <section class="lowest-price-section">
            <div class="watch-section-heading">
              <div><span class="eyebrow">BEST REGISTERED STATION PRICE</span><h3>Lowest price by fuel type</h3></div>
              <small>Click a station to find it on the map.</small>
            </div>
            <div v-if="lowestPriceRows.length" class="lowest-price-grid">
              <button
                v-for="row in lowestPriceRows"
                :key="`${row.station_id}-${row.fuel_type}`"
                class="lowest-price-card"
                :disabled="busy"
                @click="openPriceStation(row)"
              >
                <span class="watch-fuel-label">{{ row.fuel_type }}</span>
                <strong>{{ money(row.current_price) }}<small>/L</small></strong>
                <span class="lowest-price-station">{{ row.name }}</span>
                <small class="lowest-price-address">{{ row.address }}</small>
                <span class="lowest-price-link"><ion-icon :icon="locateOutline" /> View station on map</span>
              </button>
            </div>
            <p v-else class="price-watch-empty">No registered station prices are available to compare yet.</p>
          </section>

          <div v-if="priceWatchSummary.length" class="price-watch-summary">
            <article v-for="summary in priceWatchSummary" :key="summary.fuel_type" class="watch-summary-item">
              <span class="watch-fuel-label">{{ summary.fuel_type }}</span>
              <strong>{{ money(summary.average_price) }}</strong>
              <small>Average · {{ summary.station_count }} stations</small>
              <small>Range {{ money(summary.lowest_price) }}–{{ money(summary.highest_price) }}</small>
              <span :class="['watch-change', { rollback: (summary.average_change ?? 0) < 0, increase: (summary.average_change ?? 0) > 0 }]">
                {{ summary.average_change === null ? 'No price history yet' : `${summary.average_change < 0 ? 'Avg rollback' : summary.average_change > 0 ? 'Avg increase' : 'No average change'} ${money(Math.abs(summary.average_change))}` }}
              </span>
            </article>
          </div>

          <div class="price-watch-section">
            <div class="watch-section-heading"><div><span class="eyebrow">STATION-OWNER UPDATES</span><h3>Current prices and changes</h3></div></div>
            <div v-if="priceWatchRows.length" class="watch-table-wrap">
              <table class="watch-table">
                <thead><tr><th>Station</th><th>Fuel</th><th>Current / L</th><th>Previous / L</th><th>Change</th><th>Updated</th></tr></thead>
                <tbody>
                  <tr v-for="row in priceWatchRows" :key="`${row.station_id}-${row.fuel_type}`">
                    <td><strong>{{ row.name }}</strong><small>{{ row.brand }} · {{ row.address }}</small></td>
                    <td>{{ row.fuel_type }}</td>
                    <td class="watch-current">{{ money(row.current_price) }}</td>
                    <td>{{ row.previous_price === null ? '—' : money(row.previous_price) }}</td>
                    <td :class="['watch-change', { rollback: (row.price_change ?? 0) < 0, increase: (row.price_change ?? 0) > 0 }]">{{ changeLabel(row.price_change) }}</td>
                    <td>{{ formatDate(row.updated_at) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="price-watch-empty">No owner-submitted prices yet. Imported OSM locations do not include prices; station owners must claim a station and enter them.</p>
          </div>

        </section>

        <footer class="page-foot">
          <span>LowGas <span class="foot-dot">·</span> Find your next fill-up.</span>
          <span>{{ mapReady ? 'OpenStreetMap' : 'Map loading' }} <span class="foot-dot">·</span> OSRM directions</span>
        </footer>
      </main>

      <div v-if="settingsOpen" class="modal-scrim" @click.self="settingsOpen = false">
        <section class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button class="modal-close" aria-label="Close" @click="settingsOpen = false">×</button>
          <div class="modal-mark">P</div>
          <div class="eyebrow">PROFILE SETTINGS</div>
          <h2 id="settings-title">Manage your account</h2>
          <div class="profile-account-info"><span>{{ account?.role === 'station' ? 'Station owner' : 'Driver account' }}</span><small>Member since {{ formatDate(account?.createdAt) }}</small></div>
          <form class="auth-form" autocomplete="off" @submit.prevent="saveProfileSettings">
            <label>Name<input v-model="profileDraft.name" required /></label>
            <label>Email<input v-model="profileDraft.email" type="email" required /></label>
            <label>Current password<input v-model="profileDraft.currentPassword" type="password" autocomplete="current-password" :required="!!profileDraft.newPassword" /></label>
            <label>New password<input v-model="profileDraft.newPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Leave empty to keep current password" /></label>
            <label>Search radius (km)<input v-model.number="profileDraft.radiusKm" type="number" min="5" max="200" step="5" required /></label>
            <button class="submit-button" type="submit" :disabled="profileBusy">{{ profileBusy ? 'Saving…' : 'Save changes' }}</button>
          </form>
        </section>
      </div>
    </div>
    <main v-else class="auth-gate">
      <header class="auth-gate-heading">
        <a class="auth-gate-brand" href="#" aria-label="LowGas home"><span class="brand-mark">L</span><span>Low<span>Gas</span></span></a>
        <div class="eyebrow">YOUR LOCAL FUEL GUIDE</div>
        <h1>{{ authMode === 'login' ? 'Welcome to LowGas.' : 'Create your LowGas account.' }}</h1>
        <p>Sign in or create an account to find stations, compare fuel prices, and use LowGas’s features.</p>
      </header>
      <section class="auth-gate-card" aria-labelledby="auth-title">
        <div class="eyebrow">{{ authMode === 'login' ? 'ACCOUNT SIGN IN' : authRole === 'station' ? 'STATION APPLICATION' : 'JOIN LOWGAS' }}</div>
        <h2 id="auth-title">{{ authMode === 'login' ? 'Good to see you.' : authRole === 'station' ? 'Apply as a station owner.' : 'Let’s get started.' }}</h2>
        <p v-if="authError" class="auth-message is-error" role="alert">{{ authError }}</p>
        <p v-if="authSuccess" class="auth-message" role="status">{{ authSuccess }}</p>

        <div class="role-choice">
          <button :class="{ chosen: authRole === 'user' }" @click="chooseAuthRole('user')">Driver</button>
          <button :class="{ chosen: authRole === 'station' }" @click="chooseAuthRole('station')">Station owner</button>
          <button v-if="authMode === 'login'" :class="{ chosen: authRole === 'admin' }" @click="chooseAuthRole('admin')">Admin</button>
        </div>
        <p v-if="authMode === 'register' && authRole === 'station'" class="auth-application-note">Station owner accounts and listings are created only after administrator approval.</p>

        <form class="auth-form" autocomplete="off" @submit.prevent="submitAuth">
          <label v-if="authMode === 'register'">{{ authRole === 'station' ? 'Owner name' : 'Your name' }}<input v-model="authName" autocomplete="off" required /></label>
          <label>Email address<input v-model="authEmail" type="email" autocomplete="off" required /></label>
          <label>Password<input v-model="authPassword" type="password" minlength="8" autocomplete="new-password" required /></label>

          <template v-if="authMode === 'register' && authRole === 'station'">
            <label>Station name<input v-model="stationName" required /></label>
            <label>Station address<input v-model="stationAddress" required /></label>
            <label>Latitude<input v-model="stationLatitude" type="number" min="-90" max="90" step="any" required /></label>
            <label>Longitude<input v-model="stationLongitude" type="number" min="-180" max="180" step="any" required /></label>
          </template>
          <VehicleSelector v-if="authMode === 'register' && authRole === 'user'" v-model="signupVehicle" />

          <button class="submit-button" type="submit" :disabled="busy">{{ busy ? 'Please wait…' : authMode === 'login' ? 'Sign in' : authRole === 'station' ? 'Submit application' : 'Create account' }}</button>
        </form>

        <p class="auth-switch">{{ authMode === 'login' ? 'New to LowGas?' : 'Already have an account?' }} <button @click="toggleAuthMode">{{ authMode === 'login' ? 'Create account' : 'Sign in' }}</button></p>
      </section>
    </main>
  </ion-app>
</template>
