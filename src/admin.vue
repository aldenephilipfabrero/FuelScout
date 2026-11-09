<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  addOutline,
  businessOutline,
  createOutline,
  documentTextOutline,
  peopleOutline,
  pricetagOutline,
  refreshOutline,
  searchOutline,
  shieldCheckmarkOutline,
  trashOutline,
} from 'ionicons/icons'
import './admin.css'
import './admin-applications.css'

type AdminTab = 'overview' | 'users' | 'stations' | 'applications' | 'prices' | 'reports'
type AdminOverview = { total_users: number; drivers: number; station_owners: number; admins: number; pending_station_applications: number; stations: number; current_prices: number; price_changes: number; community_reports: number; reports_this_week: number }
type AdminUser = { id: number; name: string; email: string; role: string; created_at: string; station_id: number | null; station_name: string | null; report_count: number }
type AdminStation = { id: number; name: string; brand: string; address: string; latitude: number; longitude: number; created_at: string; source_ref: string | null; owner_id: number | null; owner_name: string | null; owner_email: string | null; price_count: number; report_count: number }
type StationApplication = { id: number; owner_name: string; email: string; station_name: string; address: string; latitude: number; longitude: number; submitted_at: string }
type AdminPrice = { id: number; station_id: number; station_name: string; brand: string; address: string; owner_name: string | null; fuel_type: string; price: number; source: string; updated_at: string; previous_price: number | null; changed_price: number | null; change_at: string | null; editor_name: string | null }
type AdminReport = { id: number; station_id: number; station_name: string; brand: string; address: string; user_id: number; reporter_name: string; reporter_email: string; fuel_type: string; price: number; created_at: string }
type AdminEdit = { kind: 'user'; id: number } | { kind: 'station'; id: number } | { kind: 'price' }
type AdminEditDraft = { name: string; email: string; brand: string; address: string; latitude: string; longitude: string; stationId: string; fuelType: string; price: string }

const props = defineProps<{ token: string }>()
const apiBase = import.meta.env.VITE_API_URL || '/api'
const adminTab = ref<AdminTab>('overview')
const adminBusy = ref(false)
const adminSearch = ref('')
const adminNotice = ref('')
const adminNoticeError = ref(false)
const adminOverview = ref<AdminOverview | null>(null)
const adminUsers = ref<AdminUser[]>([])
const adminStations = ref<AdminStation[]>([])
const stationApplications = ref<StationApplication[]>([])
const adminPrices = ref<AdminPrice[]>([])
const adminReports = ref<AdminReport[]>([])
const adminEditTarget = ref<AdminEdit | null>(null)
const adminEditDraft = ref<AdminEditDraft>({ name: '', email: '', brand: '', address: '', latitude: '', longitude: '', stationId: '', fuelType: 'Unleaded', price: '' })
const adminEditBusy = ref(false)

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${props.token}`,
      ...options.headers,
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.')
  return data
}

function money(price: number) {
  return `₱${price.toFixed(2)}`
}

function formatDate(value?: string) {
  if (!value) return 'time unavailable'
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function loadAdminData() {
  adminBusy.value = true
  adminNotice.value = ''
  adminNoticeError.value = false
  try {
    const search = adminSearch.value.trim()
    const query = search ? `?search=${encodeURIComponent(search)}` : ''
    const overviewRequest = request('/admin/overview')
    const dataRequest = adminTab.value === 'overview'
      ? Promise.resolve(null)
      : adminTab.value === 'prices'
        ? Promise.all([request(`/admin/prices${query}`), request('/admin/stations')])
        : adminTab.value === 'applications'
          ? request(`/admin/station-applications${query}`)
          : request(`/admin/${adminTab.value}${query}`)
    const [overviewResult, dataResult] = await Promise.all([overviewRequest, dataRequest])
    adminOverview.value = overviewResult.overview
    if (adminTab.value === 'users') adminUsers.value = dataResult.users
    if (adminTab.value === 'stations') adminStations.value = dataResult.stations
    if (adminTab.value === 'applications') stationApplications.value = dataResult.applications
    if (adminTab.value === 'prices') {
      adminPrices.value = dataResult[0].prices
      adminStations.value = dataResult[1].stations
    }
    if (adminTab.value === 'reports') adminReports.value = dataResult.reports
  } catch (error) {
    adminNotice.value = error instanceof Error ? error.message : 'Could not load administrator data.'
    adminNoticeError.value = true
  } finally {
    adminBusy.value = false
  }
}

async function selectTab(tab: AdminTab) {
  adminTab.value = tab
  await loadAdminData()
}

function beginAdminUserEdit(user: AdminUser) {
  adminEditTarget.value = { kind: 'user', id: user.id }
  adminEditDraft.value = { name: user.name, email: user.email, brand: '', address: '', latitude: '', longitude: '', stationId: '', fuelType: 'Unleaded', price: '' }
}

function beginAdminStationEdit(station: AdminStation) {
  adminEditTarget.value = { kind: 'station', id: station.id }
  adminEditDraft.value = { name: station.name, email: '', brand: station.brand, address: station.address, latitude: String(station.latitude), longitude: String(station.longitude), stationId: '', fuelType: 'Unleaded', price: '' }
}

function beginAdminPriceEdit(price?: AdminPrice) {
  adminEditTarget.value = { kind: 'price' }
  adminEditDraft.value = {
    name: '',
    email: '',
    brand: '',
    address: '',
    latitude: '',
    longitude: '',
    stationId: price ? String(price.station_id) : '',
    fuelType: price?.fuel_type ?? 'Unleaded',
    price: price ? String(price.price) : '',
  }
}

async function saveAdminEdit() {
  const target = adminEditTarget.value
  if (!target) return
  adminEditBusy.value = true
  try {
    if (target.kind === 'user') {
      await request(`/admin/users/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: adminEditDraft.value.name, email: adminEditDraft.value.email }),
      })
    } else if (target.kind === 'station') {
      await request(`/admin/stations/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: adminEditDraft.value.name,
          brand: adminEditDraft.value.brand,
          address: adminEditDraft.value.address,
          latitude: Number(adminEditDraft.value.latitude),
          longitude: Number(adminEditDraft.value.longitude),
        }),
      })
    } else {
      await request('/admin/prices', {
        method: 'POST',
        body: JSON.stringify({
          stationId: Number(adminEditDraft.value.stationId),
          fuelType: adminEditDraft.value.fuelType,
          price: Number(adminEditDraft.value.price),
        }),
      })
    }
    adminEditTarget.value = null
    await loadAdminData()
    if (!adminNoticeError.value) adminNotice.value = 'Changes saved to PostgreSQL.'
  } catch (error) {
    adminNotice.value = error instanceof Error ? error.message : 'Could not save administrator changes.'
    adminNoticeError.value = true
  } finally {
    adminEditBusy.value = false
  }
}

async function deleteAdminRecord(kind: 'users' | 'stations' | 'prices' | 'reports', id: number, label: string) {
  if (!window.confirm(`Delete ${label}? This action cannot be undone.`)) return
  adminBusy.value = true
  try {
    await request(`/admin/${kind}/${id}`, { method: 'DELETE' })
    await loadAdminData()
    if (!adminNoticeError.value) adminNotice.value = `${label} deleted.`
  } catch (error) {
    adminNotice.value = error instanceof Error ? error.message : `Could not delete ${label}.`
    adminNoticeError.value = true
    adminBusy.value = false
  }
}

async function reviewStationApplication(application: StationApplication, action: 'approve' | 'reject') {
  const actionLabel = action === 'approve' ? 'approve' : 'reject'
  if (!window.confirm(`${actionLabel[0]!.toUpperCase()}${actionLabel.slice(1)} station application for ${application.station_name}?`)) return
  adminBusy.value = true
  try {
    const path = `/admin/station-applications/${application.id}`
    await request(action === 'approve' ? `${path}/approve` : path, { method: action === 'approve' ? 'POST' : 'DELETE' })
    await loadAdminData()
    if (!adminNoticeError.value) adminNotice.value = action === 'approve'
      ? `${application.station_name} approved. The owner account and station listing are now active.`
      : `Application for ${application.station_name} rejected.`
  } catch (error) {
    adminNotice.value = error instanceof Error ? error.message : `Could not ${actionLabel} this station application.`
    adminNoticeError.value = true
  } finally {
    adminBusy.value = false
  }
}

onMounted(loadAdminData)
</script>

<template>
  <section class="admin-page">
    <div class="admin-heading">
      <div>
        <div class="eyebrow">LOWGAS CONTROL CENTER</div>
        <h2>Administration</h2>
        <p>Manage accounts, station listings, live prices, and community reports.</p>
      </div>
      <button class="location-button" :disabled="adminBusy" @click="loadAdminData"><ion-icon :icon="refreshOutline" />{{ adminBusy ? 'Refreshing…' : 'Refresh data' }}</button>
    </div>
    <p v-if="adminNotice" class="admin-notice" :class="{ 'is-error': adminNoticeError }" role="status">{{ adminNotice }}</p>

    <nav class="admin-tabs" aria-label="Admin sections">
      <button v-for="tab in (['overview', 'users', 'stations', 'applications', 'prices', 'reports'] as const)" :key="tab" :class="{ active: adminTab === tab }" @click="selectTab(tab)">
        <ion-icon :icon="tab === 'overview' ? shieldCheckmarkOutline : tab === 'users' ? peopleOutline : tab === 'stations' ? businessOutline : tab === 'prices' ? pricetagOutline : documentTextOutline" />
        {{ tab === 'users' ? 'Accounts' : tab === 'reports' ? 'Reports' : tab === 'applications' ? 'Applications' : tab[0]!.toUpperCase() + tab.slice(1) }}
        <span v-if="tab === 'reports' && adminOverview">{{ adminOverview.community_reports }}</span>
        <span v-if="tab === 'applications' && adminOverview">{{ adminOverview.pending_station_applications }}</span>
      </button>
    </nav>

    <template v-if="adminTab === 'overview'">
      <div v-if="adminBusy && !adminOverview" class="admin-loading">Loading system data…</div>
      <div v-else-if="adminOverview" class="admin-stat-grid">
        <article class="admin-stat-card"><span><ion-icon :icon="peopleOutline" /> ACCOUNTS</span><strong>{{ adminOverview.total_users.toLocaleString() }}</strong><small>{{ adminOverview.drivers }} drivers · {{ adminOverview.station_owners }} station owners · {{ adminOverview.admins }} admins</small></article>
        <article class="admin-stat-card"><span><ion-icon :icon="documentTextOutline" /> PENDING APPLICATIONS</span><strong>{{ adminOverview.pending_station_applications.toLocaleString() }}</strong><small>Station accounts waiting for approval</small></article>
        <article class="admin-stat-card"><span><ion-icon :icon="businessOutline" /> STATIONS</span><strong>{{ adminOverview.stations.toLocaleString() }}</strong><small>Registered and imported station records</small></article>
        <article class="admin-stat-card"><span><ion-icon :icon="pricetagOutline" /> CURRENT PRICES</span><strong>{{ adminOverview.current_prices.toLocaleString() }}</strong><small>{{ adminOverview.price_changes.toLocaleString() }} price changes recorded</small></article>
        <article class="admin-stat-card"><span><ion-icon :icon="documentTextOutline" /> COMMUNITY REPORTS</span><strong>{{ adminOverview.community_reports.toLocaleString() }}</strong><small>{{ adminOverview.reports_this_week }} submitted in the last 7 days</small></article>
      </div>
      <section v-if="adminOverview" class="admin-overview-actions">
        <h3>System data</h3>
        <p>All dashboard data is read from the connected PostgreSQL database. Updates made here are saved immediately.</p>
        <div>
          <button @click="selectTab('users')"><ion-icon :icon="peopleOutline" /> Manage accounts</button>
          <button @click="selectTab('stations')"><ion-icon :icon="businessOutline" /> Manage stations</button>
          <button @click="selectTab('applications')"><ion-icon :icon="documentTextOutline" /> Review station applications</button>
          <button @click="selectTab('prices')"><ion-icon :icon="pricetagOutline" /> Manage prices</button>
          <button @click="selectTab('reports')"><ion-icon :icon="documentTextOutline" /> Review reports</button>
        </div>
      </section>
    </template>

    <template v-else>
      <div class="admin-list-toolbar">
        <div>
          <h3>{{ adminTab === 'users' ? 'Accounts' : adminTab === 'stations' ? 'Stations' : adminTab === 'applications' ? 'Station applications' : adminTab === 'prices' ? 'Current fuel prices' : 'Community reports' }}</h3>
          <p>{{ adminTab === 'reports' ? 'Review and remove inappropriate or outdated submissions.' : adminTab === 'applications' ? 'Approve an application to create its owner account and publish the station, or reject it.' : 'Search records stored in PostgreSQL.' }}</p>
        </div>
        <div class="admin-search-tools">
          <label><ion-icon :icon="searchOutline" /><input v-model="adminSearch" autocomplete="off" :placeholder="`Search ${adminTab}…`" @keydown.enter="loadAdminData" /></label>
          <button class="location-button" :disabled="adminBusy" @click="loadAdminData">Search</button>
          <button v-if="adminTab === 'prices'" class="admin-add-button" @click="beginAdminPriceEdit()"><ion-icon :icon="addOutline" /> Add price</button>
        </div>
      </div>

      <div v-if="adminBusy" class="admin-loading">Loading {{ adminTab }}…</div>
      <div v-else-if="adminTab === 'users'" class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Account</th><th>Role</th><th>Station</th><th>Reports</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="user in adminUsers" :key="user.id">
              <td><strong>{{ user.name }}</strong><small>{{ user.email }} · #{{ user.id }}</small></td>
              <td><span class="admin-role-tag" :class="`role-${user.role}`">{{ user.role }}</span></td>
              <td>{{ user.station_name || '—' }}</td><td>{{ user.report_count }}</td><td>{{ formatDate(user.created_at) }}</td>
              <td class="admin-row-actions"><button aria-label="Edit account" @click="beginAdminUserEdit(user)"><ion-icon :icon="createOutline" />Edit</button><button v-if="user.role !== 'admin'" aria-label="Delete account" @click="deleteAdminRecord('users', user.id, `account ${user.email}`)"><ion-icon :icon="trashOutline" />Delete</button></td>
            </tr>
            <tr v-if="adminUsers.length === 0"><td colspan="6" class="admin-empty">No matching accounts.</td></tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="adminTab === 'stations'" class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Station</th><th>Address</th><th>Owner</th><th>Prices</th><th>Reports</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="station in adminStations" :key="station.id">
              <td><strong>{{ station.name }}</strong><small>{{ station.brand }} · #{{ station.id }}</small></td>
              <td>{{ station.address }}<small>{{ Number(station.latitude).toFixed(4) }}, {{ Number(station.longitude).toFixed(4) }}</small></td>
              <td>{{ station.owner_name || 'Unclaimed' }}<small>{{ station.owner_email || '' }}</small></td><td>{{ station.price_count }}</td><td>{{ station.report_count }}</td>
              <td class="admin-row-actions"><button aria-label="Edit station" @click="beginAdminStationEdit(station)"><ion-icon :icon="createOutline" />Edit</button><button aria-label="Delete station" @click="deleteAdminRecord('stations', station.id, `station ${station.name}`)"><ion-icon :icon="trashOutline" />Delete</button></td>
            </tr>
            <tr v-if="adminStations.length === 0"><td colspan="6" class="admin-empty">No matching stations.</td></tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="adminTab === 'applications'" class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Applicant</th><th>Station</th><th>Address and coordinates</th><th>Submitted</th><th>Review</th></tr></thead>
          <tbody>
            <tr v-for="application in stationApplications" :key="application.id">
              <td><strong>{{ application.owner_name }}</strong><small>{{ application.email }}</small></td>
              <td><strong>{{ application.station_name }}</strong><small>Application #{{ application.id }}</small></td>
              <td>{{ application.address }}<small>{{ Number(application.latitude).toFixed(5) }}, {{ Number(application.longitude).toFixed(5) }}</small></td>
              <td>{{ formatDate(application.submitted_at) }}</td>
              <td class="admin-application-actions">
                <button class="admin-approve-button" :disabled="adminBusy" @click="reviewStationApplication(application, 'approve')">Approve</button>
                <button class="admin-reject-button" :disabled="adminBusy" @click="reviewStationApplication(application, 'reject')">Reject</button>
              </td>
            </tr>
            <tr v-if="stationApplications.length === 0"><td colspan="5" class="admin-empty">No station applications are waiting for review.</td></tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="adminTab === 'prices'" class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Station</th><th>Fuel</th><th>Current / L</th><th>Previous / L</th><th>Last change</th><th>Source / updated</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="price in adminPrices" :key="price.id">
              <td><strong>{{ price.station_name }}</strong><small>{{ price.brand }} · {{ price.owner_name || 'No linked owner' }}</small></td><td>{{ price.fuel_type }}</td><td><strong>{{ money(Number(price.price)) }}</strong></td><td>{{ price.previous_price === null ? '—' : money(Number(price.previous_price)) }}</td>
              <td>{{ price.changed_price === null || price.previous_price === null ? 'No change recorded' : `${Number(price.changed_price) < Number(price.previous_price) ? 'Rollback' : 'Change'} ${money(Math.abs(Number(price.changed_price) - Number(price.previous_price)))}` }}<small>{{ price.change_at ? `by ${price.editor_name || 'former user'}` : '' }}</small></td>
              <td>{{ price.source }}<small>{{ formatDate(price.updated_at) }}</small></td>
              <td class="admin-row-actions"><button aria-label="Edit fuel price" @click="beginAdminPriceEdit(price)"><ion-icon :icon="createOutline" />Edit</button><button aria-label="Delete fuel price" @click="deleteAdminRecord('prices', price.id, `${price.fuel_type} price at ${price.station_name}`)"><ion-icon :icon="trashOutline" />Delete</button></td>
            </tr>
            <tr v-if="adminPrices.length === 0"><td colspan="7" class="admin-empty">No current prices in the database.</td></tr>
          </tbody>
        </table>
      </div>

      <div v-else class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Station</th><th>Fuel</th><th>Reported price</th><th>Submitted by</th><th>Submitted</th><th>Action</th></tr></thead>
          <tbody>
            <tr v-for="report in adminReports" :key="report.id">
              <td><strong>{{ report.station_name }}</strong><small>{{ report.brand }} · {{ report.address }}</small></td><td>{{ report.fuel_type }}</td><td><strong>{{ money(Number(report.price)) }}</strong></td><td>{{ report.reporter_name }}<small>{{ report.reporter_email }}</small></td><td>{{ formatDate(report.created_at) }}</td>
              <td class="admin-row-actions"><button aria-label="Delete community report" @click="deleteAdminRecord('reports', report.id, `report #${report.id}`)"><ion-icon :icon="trashOutline" />Delete</button></td>
            </tr>
            <tr v-if="adminReports.length === 0"><td colspan="6" class="admin-empty">No matching community reports.</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>

  <div v-if="adminEditTarget" class="modal-scrim admin-modal-scrim" @click.self="adminEditTarget = null">
    <section class="auth-modal admin-edit-modal" role="dialog" aria-modal="true" aria-labelledby="admin-edit-title">
      <button class="modal-close" aria-label="Close" @click="adminEditTarget = null">×</button>
      <div class="modal-mark"><ion-icon :icon="adminEditTarget.kind === 'user' ? peopleOutline : adminEditTarget.kind === 'station' ? businessOutline : pricetagOutline" /></div>
      <div class="eyebrow">POSTGRESQL DATA</div>
      <h2 id="admin-edit-title">{{ adminEditTarget.kind === 'user' ? 'Edit account' : adminEditTarget.kind === 'station' ? 'Edit station' : 'Manage fuel price' }}</h2>
      <form class="auth-form" autocomplete="off" @submit.prevent="saveAdminEdit">
        <template v-if="adminEditTarget.kind === 'user'">
          <label>Name<input v-model="adminEditDraft.name" autocomplete="name" required /></label>
          <label>Email<input v-model="adminEditDraft.email" type="email" autocomplete="email" required /></label>
          <p class="admin-modal-note">Administrator roles and passwords are managed separately for account security.</p>
        </template>
        <template v-else-if="adminEditTarget.kind === 'station'">
          <label>Station name<input v-model="adminEditDraft.name" required /></label>
          <label>Brand<input v-model="adminEditDraft.brand" required /></label>
          <label>Address<input v-model="adminEditDraft.address" required /></label>
          <div class="admin-coordinate-fields">
            <label>Latitude<input v-model="adminEditDraft.latitude" type="number" min="-90" max="90" step="any" required /></label>
            <label>Longitude<input v-model="adminEditDraft.longitude" type="number" min="-180" max="180" step="any" required /></label>
          </div>
        </template>
        <template v-else>
          <label>Station<select v-model="adminEditDraft.stationId" required><option value="" disabled>Select station</option><option v-for="station in adminStations" :key="station.id" :value="String(station.id)">{{ station.name }} · #{{ station.id }}</option></select></label>
          <label>Fuel type<select v-model="adminEditDraft.fuelType" required><option>Unleaded</option><option>Diesel</option><option>Premium</option></select></label>
          <label>Current price per liter<input v-model="adminEditDraft.price" type="number" min="0.01" max="1000" step="0.01" required /></label>
          <p class="admin-modal-note">Saving a changed price updates the current station price and records the previous and new prices in history.</p>
        </template>
        <button class="submit-button" type="submit" :disabled="adminEditBusy">{{ adminEditBusy ? 'Saving…' : 'Save changes' }}</button>
      </form>
    </section>
  </div>
</template>
