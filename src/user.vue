<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  arrowForwardOutline,
  carOutline,
  createOutline,
  personCircleOutline,
  pricetagOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons'
import './user.css'
import VehicleSelector from './components/VehicleSelector.vue'
import type { VehicleRecord } from './types/vehicle'

type UserAccount = { id: number; name: string; email: string; role: 'user' | 'station' | 'admin'; searchRadiusKm?: number; vehicle: VehicleRecord | null; createdAt?: string }
type UserTab = 'overview' | 'profile'
type FuelExpense = { id: number; fuel_type: string; liters: number; price_per_liter: number; total_cost: number; station_name: string | null; purchased_at: string; created_at: string }
type MonthlyExpenseTotal = { month: string; total_cost: number; liters: number; transaction_count: number }
type PriceNotification = { id: number; type: 'price_increase' | 'price_rollback'; station_name: string; fuel_type: string; previous_price: number; new_price: number; created_at: string; read_at: string | null }

const props = defineProps<{
  account: UserAccount
  token: string
  startTab: UserTab
}>()

const emit = defineEmits<{
  accountUpdated: [payload: { account: UserAccount; token: string }]
  navigate: [page: 'stations' | 'price-watch']
}>()

const apiBase = import.meta.env.VITE_API_URL || '/api'
const activeTab = ref<UserTab>(props.startTab)
const name = ref(props.account.name)
const email = ref(props.account.email)
const currentPassword = ref('')
const newPassword = ref('')
const radiusKm = ref(props.account.searchRadiusKm ?? 25)
const vehicle = ref<VehicleRecord | null>(props.account.vehicle)
const nameInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const message = ref('')
const messageError = ref(false)
const initials = computed(() => props.account.name.trim().charAt(0).toUpperCase() || 'U')
const expenses = ref<FuelExpense[]>([])
const monthlyExpenseTotals = ref<MonthlyExpenseTotal[]>([])
const currentExpenseMonth = localDateInput().slice(0, 7)
const currentMonthTotal = computed(() => monthlyExpenseTotals.value.find((month) => month.month === currentExpenseMonth)?.total_cost ?? 0)
const currentMonthTransactions = computed(() => monthlyExpenseTotals.value.find((month) => month.month === currentExpenseMonth)?.transaction_count ?? 0)
const notifications = ref<PriceNotification[]>([])
const unreadCount = ref(0)
const expenseFuelType = ref('Unleaded')
const expenseLiters = ref<number | null>(null)
const expensePricePerLiter = ref<number | null>(null)
const expenseStation = ref('')
function localDateInput() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const expenseDate = ref(localDateInput())
const expenseBusy = ref(false)
const expenseMessage = ref('')
const expenseMessageError = ref(false)
let notificationRefreshTimer: ReturnType<typeof setInterval> | null = null
const estimatedExpenseTotal = computed(() => {
  const liters = Number(expenseLiters.value)
  const price = Number(expensePricePerLiter.value)
  return Number.isFinite(liters) && Number.isFinite(price) ? liters * price : 0
})

function formatDate(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(value))
}

function money(value: number) {
  return `₱${value.toFixed(2)}`
}

function formatExpenseMonth(value: string) {
  return new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(new Date(`${value}-01T00:00:00`))
}

function adjustMonthlyExpenseTotal(record: FuelExpense, direction: 1 | -1) {
  const month = monthlyExpenseTotals.value.find((item) => item.month === record.purchased_at.slice(0, 7))
  if (!month) return
  month.total_cost = Number((month.total_cost + direction * record.total_cost).toFixed(2))
  month.liters = Number((month.liters + direction * record.liters).toFixed(2))
  month.transaction_count = Math.max(0, month.transaction_count + direction)
}

async function loadAccountData() {
  try {
    const headers = { Authorization: `Bearer ${props.token}` }
    const [expenseResponse, notificationResponse] = await Promise.all([
      fetch(`${apiBase}/user/financial-records`, { headers }),
      fetch(`${apiBase}/notifications`, { headers }),
    ])
    const expenseResult = await expenseResponse.json().catch(() => ({}))
    const notificationResult = await notificationResponse.json().catch(() => ({}))
    if (!expenseResponse.ok) throw new Error(expenseResult.error || 'Could not load your financial records.')
    if (!notificationResponse.ok) throw new Error(notificationResult.error || 'Could not load your notifications.')
    expenses.value = expenseResult.records
    monthlyExpenseTotals.value = expenseResult.monthlyTotals
    notifications.value = notificationResult.notifications
    unreadCount.value = notificationResult.unreadCount
  } catch (error) {
    expenseMessage.value = error instanceof Error ? error.message : 'Could not load account data.'
    expenseMessageError.value = true
  }
}

async function refreshNotifications() {
  try {
    const response = await fetch(`${apiBase}/notifications`, {
      headers: { Authorization: `Bearer ${props.token}` },
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Could not refresh notifications.')
    notifications.value = result.notifications
    unreadCount.value = result.unreadCount
  } catch (error) {
    expenseMessage.value = error instanceof Error ? error.message : 'Could not refresh notifications.'
    expenseMessageError.value = true
  }
}

async function addExpense() {
  expenseBusy.value = true
  expenseMessage.value = ''
  expenseMessageError.value = false
  try {
    const response = await fetch(`${apiBase}/user/financial-records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${props.token}` },
      body: JSON.stringify({
        fuelType: expenseFuelType.value,
        liters: Number(expenseLiters.value),
        pricePerLiter: Number(expensePricePerLiter.value),
        stationName: expenseStation.value.trim() || undefined,
        purchasedAt: expenseDate.value,
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Could not save your financial record.')
    expenses.value = [result.record, ...expenses.value]
    adjustMonthlyExpenseTotal(result.record, 1)
    expenseLiters.value = null
    expensePricePerLiter.value = null
    expenseStation.value = ''
    expenseDate.value = localDateInput()
    expenseMessage.value = 'Fuel expense saved to your account.'
  } catch (error) {
    expenseMessage.value = error instanceof Error ? error.message : 'Could not save your financial record.'
    expenseMessageError.value = true
  } finally {
    expenseBusy.value = false
  }
}

async function deleteExpense(record: FuelExpense) {
  expenseMessage.value = ''
  try {
    const response = await fetch(`${apiBase}/user/financial-records/${record.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${props.token}` },
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Could not delete the financial record.')
    expenses.value = expenses.value.filter((item) => item.id !== record.id)
    adjustMonthlyExpenseTotal(record, -1)
    expenseMessage.value = 'Financial record deleted.'
    expenseMessageError.value = false
  } catch (error) {
    expenseMessage.value = error instanceof Error ? error.message : 'Could not delete the financial record.'
    expenseMessageError.value = true
  }
}

async function markNotificationRead(notification: PriceNotification) {
  if (notification.read_at) return
  try {
    const response = await fetch(`${apiBase}/notifications/${notification.id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${props.token}` },
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Could not update the notification.')
    notification.read_at = new Date().toISOString()
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  } catch (error) {
    expenseMessage.value = error instanceof Error ? error.message : 'Could not update the notification.'
    expenseMessageError.value = true
  }
}

async function markAllNotificationsRead() {
  try {
    const response = await fetch(`${apiBase}/notifications/read-all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${props.token}` },
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Could not update notifications.')
    const readAt = new Date().toISOString()
    notifications.value.forEach((notification) => { notification.read_at ??= readAt })
    unreadCount.value = 0
  } catch (error) {
    expenseMessage.value = error instanceof Error ? error.message : 'Could not update notifications.'
    expenseMessageError.value = true
  }
}

async function saveProfile() {
  busy.value = true
  message.value = ''
  messageError.value = false
  try {
    const payload: { name: string; email: string; searchRadiusKm: number; vehicle: VehicleRecord | null; currentPassword?: string; newPassword?: string } = {
      name: name.value.trim(),
      email: email.value.trim(),
      searchRadiusKm: radiusKm.value,
      vehicle: vehicle.value,
    }
    if (newPassword.value) {
      payload.currentPassword = currentPassword.value
      payload.newPassword = newPassword.value
    }
    const response = await fetch(`${apiBase}/auth/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${props.token}`,
      },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Could not save profile.')

    const nextToken = result.token as string
    const nextAccount = result.account as UserAccount
    localStorage.setItem('lowgas-token', nextToken)
    emit('accountUpdated', { account: nextAccount, token: nextToken })
    name.value = nextAccount.name
    email.value = nextAccount.email
    vehicle.value = nextAccount.vehicle
    currentPassword.value = ''
    newPassword.value = ''
    message.value = 'Profile saved to your account.'
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Could not save profile.'
    messageError.value = true
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void loadAccountData()
  notificationRefreshTimer = setInterval(() => { void refreshNotifications() }, 30_000)
})

onBeforeUnmount(() => {
  if (notificationRefreshTimer) clearInterval(notificationRefreshTimer)
})
</script>

<template>
  <section class="user-page">
    <header class="user-heading">
      <div>
        <div class="eyebrow">YOUR LOWGAS ACCOUNT</div>
        <h2>{{ activeTab === 'overview' ? `Welcome, ${account.name}` : 'Your profile' }}</h2>
        <p>{{ activeTab === 'overview' ? 'Your account and shortcuts for finding fuel.' : 'View and update your personal account information.' }}</p>
      </div>
      <span class="user-dashboard-avatar">{{ initials }}</span>
    </header>

    <nav class="user-tabs" aria-label="User dashboard">
      <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'"><ion-icon :icon="carOutline" /> Dashboard</button>
      <button :class="{ active: activeTab === 'profile' }" @click="activeTab = 'profile'"><ion-icon :icon="personCircleOutline" /> My profile</button>
    </nav>

    <template v-if="activeTab === 'overview'">
      <div class="user-welcome-card">
        <div class="user-welcome-mark"><ion-icon :icon="shieldCheckmarkOutline" /></div>
        <div>
          <span class="eyebrow">DRIVER ACCOUNT</span>
          <h3>Welcome to your dashboard</h3>
          <p>Your account profile is ready. Find a nearby station or compare current station-owner prices.</p>
        </div>
      </div>

      <div class="user-dashboard-grid">
        <article class="user-info-card">
          <div class="user-card-heading"><ion-icon :icon="personCircleOutline" /><h3>Account information</h3></div>
          <dl>
            <div><dt>Name</dt><dd>{{ account.name }}</dd></div>
            <div><dt>Email</dt><dd>{{ account.email }}</dd></div>
            <div><dt>Account type</dt><dd>Driver</dd></div>
            <div><dt>Vehicle</dt><dd>{{ account.vehicle ? `${account.vehicle.year} ${account.vehicle.make} ${account.vehicle.model} ${account.vehicle.variant}` : 'Not set' }}</dd></div>
            <div v-if="account.vehicle"><dt>Vehicle kind</dt><dd>{{ account.vehicle.category }}</dd></div>
            <div v-if="account.vehicle?.type"><dt>Vehicle class</dt><dd>{{ account.vehicle?.type }}</dd></div>
            <div v-if="account.vehicle"><dt>Fuel economy</dt><dd>{{ account.vehicle?.fuelEconomyKmL?.toFixed(2) }} km/L · {{ account.vehicle?.economySource }}</dd></div>
            <div><dt>Member since</dt><dd>{{ formatDate(account.createdAt) }}</dd></div>
            <div><dt>Search radius</dt><dd>{{ radiusKm }} km</dd></div>
          </dl>
          <button class="user-text-button" @click="activeTab = 'profile'">Edit profile <ion-icon :icon="arrowForwardOutline" /></button>
        </article>

        <article class="user-shortcuts-card">
          <span class="eyebrow">QUICK LINKS</span>
          <h3>What would you like to do?</h3>
          <button @click="emit('navigate', 'stations')"><span class="user-shortcut-icon"><ion-icon :icon="carOutline" /></span><span><strong>Find nearby fuel</strong><small>Search stations around your location</small></span><ion-icon :icon="arrowForwardOutline" /></button>
          <button @click="emit('navigate', 'price-watch')"><span class="user-shortcut-icon"><ion-icon :icon="pricetagOutline" /></span><span><strong>Compare fuel prices</strong><small>View station-owner prices and updates</small></span><ion-icon :icon="arrowForwardOutline" /></button>
        </article>
      </div>

      <div class="user-dashboard-records">
        <article class="user-record-card">
          <div class="user-record-heading">
            <div><span class="eyebrow">PERSONAL FINANCES</span><h3>Fuel transactions</h3></div>
          </div>
          <p v-if="expenseMessage" class="user-profile-message" :class="{ 'is-error': expenseMessageError }" role="status">{{ expenseMessage }}</p>
          <section class="user-monthly-expense" aria-label="Fuel cost this month">
            <div><span class="eyebrow">{{ formatExpenseMonth(currentExpenseMonth) }}</span><strong>{{ money(currentMonthTotal) }}</strong><small>Fuel cost this month</small></div>
            <span class="user-monthly-count">{{ currentMonthTransactions }} {{ currentMonthTransactions === 1 ? 'transaction' : 'transactions' }}</span>
          </section>
          <section class="user-monthly-history" aria-label="Monthly fuel cost for the last 12 months">
            <h4>Monthly fuel costs</h4>
            <div class="user-monthly-list">
              <div v-for="month in monthlyExpenseTotals" :key="month.month" class="user-monthly-row" :class="{ current: month.month === currentExpenseMonth }">
                <span>{{ formatExpenseMonth(month.month) }}</span>
                <small>{{ month.transaction_count }} {{ month.transaction_count === 1 ? 'fill-up' : 'fill-ups' }} · {{ month.liters.toFixed(2) }} L</small>
                <strong>{{ money(month.total_cost) }}</strong>
              </div>
            </div>
          </section>
          <form class="user-expense-form" autocomplete="off" @submit.prevent="addExpense">
            <label>Fuel type
              <select v-model="expenseFuelType" required>
                <option>Unleaded</option><option>Diesel</option><option>Premium</option>
              </select>
            </label>
            <label>Quantity (L)<input v-model.number="expenseLiters" type="number" min="0.01" max="10000" step="0.01" required /></label>
            <label>Price per liter<input v-model.number="expensePricePerLiter" type="number" min="0.01" max="1000" step="0.01" required /></label>
            <label>Purchase date<input v-model="expenseDate" type="date" :max="localDateInput()" required /></label>
            <label class="user-expense-station">Station (optional)<input v-model="expenseStation" maxlength="120" placeholder="Station name" /></label>
            <div class="user-expense-total"><span>Total expense</span><strong>{{ money(estimatedExpenseTotal) }}</strong></div>
            <button class="submit-button" type="submit" :disabled="expenseBusy">{{ expenseBusy ? 'Saving…' : 'Add expense' }}</button>
          </form>
          <div v-if="expenses.length" class="user-expense-list">
            <div v-for="record in expenses" :key="record.id" class="user-expense-row">
              <div><strong>{{ record.fuel_type }} · {{ money(record.total_cost) }}</strong><small>{{ record.liters.toFixed(2) }} L at {{ money(record.price_per_liter) }}/L · {{ record.station_name || 'Station not specified' }}</small></div>
              <time>{{ formatDate(record.purchased_at) }}</time>
              <button type="button" aria-label="Delete financial record" @click="deleteExpense(record)">Delete</button>
            </div>
          </div>
          <p v-else class="user-record-empty">No fuel expenses recorded yet.</p>
        </article>

        <article class="user-record-card">
          <div class="user-record-heading">
            <div><span class="eyebrow">PRICE ALERTS</span><h3>Gas price notifications <span v-if="unreadCount" class="user-unread-count">{{ unreadCount }}</span></h3></div>
            <button v-if="unreadCount" class="user-mark-read" type="button" @click="markAllNotificationsRead">Mark all read</button>
          </div>
          <div v-if="notifications.length" class="user-notification-list">
            <article v-for="notification in notifications" :key="notification.id" class="user-notification" :class="{ unread: !notification.read_at, rollback: notification.type === 'price_rollback' }">
              <div class="user-notification-copy">
                <strong>{{ notification.type === 'price_rollback' ? 'Price rollback' : 'Price increase' }} · {{ notification.fuel_type }}</strong>
                <p>{{ notification.station_name }} changed from {{ money(notification.previous_price) }} to {{ money(notification.new_price) }} per liter.</p>
                <time>{{ formatDate(notification.created_at) }}</time>
              </div>
              <button v-if="!notification.read_at" class="user-mark-read" type="button" @click="markNotificationRead(notification)">Mark read</button>
            </article>
          </div>
          <p v-else class="user-record-empty">No price notifications yet. Increases and rollbacks at registered stations will appear here.</p>
        </article>
      </div>
    </template>

    <article v-else class="user-profile-card">
      <div class="user-profile-summary">
        <span class="user-profile-avatar">{{ initials }}</span>
        <div><h3>{{ account.name }}</h3><p>{{ account.email }}</p></div>
        <button class="user-edit-button" type="button" @click="nameInput?.focus()"><ion-icon :icon="createOutline" /> Edit details</button>
      </div>
      <p v-if="message" class="user-profile-message" :class="{ 'is-error': messageError }" role="status">{{ message }}</p>
      <form class="user-profile-form" autocomplete="off" @submit.prevent="saveProfile">
        <label>Name<input ref="nameInput" v-model="name" id="user-profile-name" autocomplete="name" required /></label>
        <label>Email<input v-model="email" type="email" autocomplete="email" required /></label>
        <label>Search radius (km)<input v-model.number="radiusKm" type="number" min="5" max="200" step="5" required /></label>
        <VehicleSelector v-model="vehicle" />
        <div class="user-password-fields">
          <label>Current password<input v-model="currentPassword" type="password" autocomplete="current-password" :required="!!newPassword" /></label>
          <label>New password<input v-model="newPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Leave empty to keep current password" /></label>
        </div>
        <button class="submit-button" type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Save changes' }}</button>
      </form>
    </article>
  </section>
</template>
