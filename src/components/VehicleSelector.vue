<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SearchableCatalogField from './SearchableCatalogField.vue'
import type { EpaVehicleDetails, VehicleCatalogOption, VehicleCategory, VehicleRecord } from '../types/vehicle'

const props = defineProps<{ modelValue: VehicleRecord | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: VehicleRecord | null] }>()

const apiBase = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '/api' : 'https://fuelscout-api.onrender.com/api')
const years = ref<number[]>([])
const makes = ref<string[]>([])
const models = ref<string[]>([])
const motorcycleYears = ref<number[]>([])
const motorcycleMakes = ref<string[]>([])
const motorcycleModels = ref<string[]>([])
const options = ref<VehicleCatalogOption[]>([])
const selectedYear = ref<number | ''>('')
const selectedMake = ref('')
const selectedModel = ref('')
const selectedEpaId = ref<number | ''>('')
const category = ref<VehicleCategory>(props.modelValue?.category ?? 'Car / Sedan')
const motorcycleYear = ref<number | ''>(props.modelValue?.category === 'Motorcycle' ? props.modelValue.year : '')
const motorcycleMake = ref(props.modelValue?.category === 'Motorcycle' ? props.modelValue.make : '')
const motorcycleModel = ref(props.modelValue?.category === 'Motorcycle' ? props.modelValue.model : '')
const motorcycleVersion = ref(props.modelValue?.category === 'Motorcycle' ? props.modelValue.version : '')
const variant = ref(props.modelValue?.variant ?? '')
const vehicleDetails = ref<EpaVehicleDetails | null>(props.modelValue)
const busy = ref(false)
const errorMessage = ref('')

async function catalogRequest<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`)
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Could not load vehicle data.')
  return result as T
}

async function initialize() {
  if (props.modelValue?.category === 'Motorcycle') {
    category.value = 'Motorcycle'
    variant.value = props.modelValue.variant
    motorcycleVersion.value = props.modelValue.version
    await loadMotorcycleCatalog()
    return
  }
  category.value = props.modelValue?.category ?? 'Car / Sedan'
  busy.value = true
  errorMessage.value = ''
  try {
    years.value = await catalogRequest<number[]>('/vehicles/years')
    if (props.modelValue) {
      selectedYear.value = props.modelValue.year
      selectedMake.value = props.modelValue.make
      selectedModel.value = props.modelValue.model
      selectedEpaId.value = props.modelValue.epaId ?? ''
      await loadMakes(false)
      await loadModels(false)
      await loadOptions(false)
      variant.value = props.modelValue.variant
      vehicleDetails.value = props.modelValue
    } else {
      selectedYear.value = years.value[0] ?? ''
      await loadMakes(true)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load vehicle catalog.'
  } finally {
    busy.value = false
  }
}

function changeCategory() {
  errorMessage.value = ''
  selectedYear.value = ''
  selectedMake.value = ''
  selectedModel.value = ''
  selectedEpaId.value = ''
  makes.value = []
  models.value = []
  options.value = []
  vehicleDetails.value = null
  variant.value = ''
  motorcycleYear.value = ''
  motorcycleMake.value = ''
  motorcycleModel.value = ''
  motorcycleModels.value = []
  emit('update:modelValue', null)
  if (category.value === 'Motorcycle') {
    void loadMotorcycleCatalog()
    return
  }
  void loadCatalogYears()
}

async function loadMotorcycleCatalog() {
  busy.value = true
  errorMessage.value = ''
  try {
    motorcycleYears.value = await catalogRequest<number[]>('/vehicles/motorcycles/years')
    motorcycleMakes.value = await catalogRequest<string[]>('/vehicles/motorcycles/makes')
    if (props.modelValue?.category === 'Motorcycle') {
      motorcycleYear.value = props.modelValue.year
      motorcycleMake.value = props.modelValue.make
      motorcycleModel.value = props.modelValue.model
      await loadMotorcycleModels()
    } else {
      motorcycleYear.value = motorcycleYears.value[0] ?? ''
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load motorcycle catalog.'
  } finally {
    busy.value = false
  }
}

async function loadMotorcycleModels() {
  if (!motorcycleYear.value || !motorcycleMake.value) {
    motorcycleModels.value = []
    return
  }
  motorcycleModels.value = await catalogRequest<string[]>(
    `/vehicles/motorcycles/models?year=${motorcycleYear.value}&make=${encodeURIComponent(motorcycleMake.value)}`,
  )
}

async function loadCatalogYears() {
  busy.value = true
  errorMessage.value = ''
  try {
    years.value = await catalogRequest<number[]>('/vehicles/years')
    selectedYear.value = years.value[0] ?? ''
    await loadMakes(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load vehicle catalog.'
  } finally {
    busy.value = false
  }
}

function updateMotorcycle() {
  if (!motorcycleYear.value || !motorcycleMake.value || !motorcycleModel.value || !variant.value.trim() || !motorcycleVersion.value.trim()) {
    emit('update:modelValue', null)
    return
  }
  emit('update:modelValue', {
    category: 'Motorcycle',
    epaId: null,
    make: motorcycleMake.value,
    model: motorcycleModel.value,
    type: null,
    variant: variant.value.trim(),
    version: motorcycleVersion.value.trim(),
    year: motorcycleYear.value,
    fuelType: 'Gasoline',
    fuelEconomyKmL: 35,
    economySource: 'Typical estimate',
  })
}

function handleMotorcycleMakeInput(value: string) {
  motorcycleMake.value = value
  motorcycleModel.value = ''
  motorcycleModels.value = []
  updateMotorcycle()
}

function selectMotorcycleMake(make: string) {
  motorcycleMake.value = make
  void handleMotorcycleMakeChange()
}

function handleMotorcycleModelInput(value: string) {
  motorcycleModel.value = value
  updateMotorcycle()
}

function commitMotorcycleMake(value: string) {
  if (value) void handleMotorcycleMakeChange()
}

function handleEpaMakeInput(value: string) {
  selectedMake.value = value
  selectedModel.value = ''
  selectedEpaId.value = ''
  models.value = []
  options.value = []
  vehicleDetails.value = null
  emit('update:modelValue', null)
}

function selectEpaMake(make: string) {
  selectedMake.value = make
  void handleMakeChange()
}

function commitEpaMake(value: string) {
  const match = makes.value.find((make) => make.toLocaleLowerCase() === value.trim().toLocaleLowerCase())
  if (match) selectEpaMake(match)
}

function handleEpaModelInput(value: string) {
  selectedModel.value = value
  selectedEpaId.value = ''
  options.value = []
  vehicleDetails.value = null
  emit('update:modelValue', null)
}

function selectEpaModel(model: string) {
  selectedModel.value = model
  void handleModelChange()
}

function commitEpaModel(value: string) {
  const match = models.value.find((model) => model.toLocaleLowerCase() === value.trim().toLocaleLowerCase())
  if (match) selectEpaModel(match)
}

function handleMotorcycleYearChange() {
  motorcycleMake.value = ''
  motorcycleModel.value = ''
  motorcycleModels.value = []
  emit('update:modelValue', null)
}

async function handleMotorcycleMakeChange() {
  motorcycleModel.value = ''
  motorcycleModels.value = []
  emit('update:modelValue', null)
  busy.value = true
  errorMessage.value = ''
  try {
    await loadMotorcycleModels()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load motorcycle models.'
  } finally {
    busy.value = false
  }
}

async function loadMakes(clearSelection: boolean) {
  if (clearSelection) {
    selectedMake.value = ''
    selectedModel.value = ''
    selectedEpaId.value = ''
    models.value = []
    options.value = []
    vehicleDetails.value = null
    emit('update:modelValue', null)
  }
  if (!selectedYear.value) {
    makes.value = []
    return
  }
  makes.value = await catalogRequest<string[]>(`/vehicles/makes?year=${selectedYear.value}`)
  if (!clearSelection && props.modelValue) selectedMake.value = props.modelValue.make
  else selectedMake.value = ''
}

async function loadModels(clearSelection: boolean) {
  if (clearSelection) {
    selectedModel.value = ''
    selectedEpaId.value = ''
    options.value = []
    vehicleDetails.value = null
    emit('update:modelValue', null)
  }
  if (!selectedYear.value || !selectedMake.value) {
    models.value = []
    return
  }
  models.value = await catalogRequest<string[]>(`/vehicles/models?year=${selectedYear.value}&make=${encodeURIComponent(selectedMake.value)}`)
  if (!clearSelection && props.modelValue) selectedModel.value = props.modelValue.model
  else selectedModel.value = ''
}

async function loadOptions(clearSelection: boolean) {
  if (clearSelection) {
    selectedEpaId.value = ''
    vehicleDetails.value = null
    emit('update:modelValue', null)
  }
  if (!selectedYear.value || !selectedMake.value || !selectedModel.value) {
    options.value = []
    return
  }
  options.value = await catalogRequest<VehicleCatalogOption[]>(
    `/vehicles/options?year=${selectedYear.value}&make=${encodeURIComponent(selectedMake.value)}&model=${encodeURIComponent(selectedModel.value)}`,
  )
  if (!clearSelection && props.modelValue) selectedEpaId.value = props.modelValue.epaId ?? ''
  else selectedEpaId.value = ''
}

async function selectOption() {
  errorMessage.value = ''
  vehicleDetails.value = null
  emit('update:modelValue', null)
  if (!selectedEpaId.value) return
  busy.value = true
  try {
    vehicleDetails.value = await catalogRequest<EpaVehicleDetails>(`/vehicles/${selectedEpaId.value}`)
    emit('update:modelValue', { ...vehicleDetails.value, category: category.value, variant: variant.value.trim(), economySource: 'EPA' })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load the selected vehicle.'
    selectedEpaId.value = ''
  } finally {
    busy.value = false
  }
}

function updateVariant() {
  if (vehicleDetails.value) {
    emit('update:modelValue', { ...vehicleDetails.value, category: category.value, variant: variant.value.trim(), economySource: 'EPA' })
  }
}

async function handleYearChange() {
  busy.value = true
  errorMessage.value = ''
  try {
    await loadMakes(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load vehicle makes.'
  } finally {
    busy.value = false
  }
}

async function handleMakeChange() {
  busy.value = true
  errorMessage.value = ''
  try {
    await loadModels(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load vehicle models.'
  } finally {
    busy.value = false
  }
}

async function handleModelChange() {
  busy.value = true
  errorMessage.value = ''
  try {
    await loadOptions(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load vehicle versions.'
  } finally {
    busy.value = false
  }
}

onMounted(initialize)
</script>

<template>
  <div class="vehicle-selector">
    <label>Vehicle kind
      <select v-model="category" required :disabled="busy" @change="changeCategory">
        <option>Motorcycle</option><option>Car / Sedan</option><option>SUV</option><option>Pickup / Truck</option><option>Van</option><option>Other</option>
      </select>
    </label>
    <template v-if="category === 'Motorcycle'">
      <label>Model year
        <input v-model.number="motorcycleYear" type="number" min="1981" :max="new Date().getFullYear() + 1" list="motorcycle-years" placeholder="Enter year" required @change="handleMotorcycleYearChange" />
        <datalist id="motorcycle-years">
          <option v-for="year in motorcycleYears" :key="year" :value="year" />
        </datalist>
      </label>
      <label>Make / manufacturer
        <SearchableCatalogField
          id="motorcycle-make"
          :model-value="motorcycleMake"
          :options="motorcycleMakes"
          placeholder="Type to search brands"
          empty-message="No catalog match; your typed brand can still be used."
          :max-length="80"
          @update:model-value="handleMotorcycleMakeInput"
          @select="selectMotorcycleMake"
          @commit="commitMotorcycleMake"
        />
      </label>
      <label>Model
        <SearchableCatalogField
          id="motorcycle-model"
          :model-value="motorcycleModel"
          :options="motorcycleModels"
          placeholder="Type to search models"
          empty-message="No catalog match; your typed model can still be used."
          @update:model-value="handleMotorcycleModelInput"
        />
      </label>
      <label>Variant / trim<input v-model="variant" maxlength="80" placeholder="e.g. Standard, CBS" required @input="updateMotorcycle" /></label>
      <label>Version / engine<input v-model="motorcycleVersion" maxlength="100" placeholder="e.g. 125 cc, automatic" required @input="updateMotorcycle" /></label>
      <p v-if="busy" class="vehicle-selector-status" role="status">Loading motorcycle catalog…</p>
      <p v-if="errorMessage" class="vehicle-selector-status is-error" role="alert">{{ errorMessage }}</p>
      <p v-if="!busy && motorcycleYear && motorcycleMake && !motorcycleModels.length" class="vehicle-selector-status">No models are listed for this year and make. Try another catalog selection.</p>
      <p class="vehicle-selector-status"><strong>Typical motorcycle estimate:</strong> 35 km/L. Actual mileage varies by model and riding conditions.</p>
      <p class="vehicle-selector-disclaimer">Type part of a brand or model to search suggestions, or enter your own if it is not listed. The U.S. NHTSA catalog may not include all Philippine-market motorcycles. Variant and engine details are entered manually.</p>
    </template>
    <template v-else>
    <label>Model year
      <select v-model.number="selectedYear" required :disabled="busy" @change="handleYearChange">
        <option value="" disabled>Select year</option>
        <option v-for="year in years" :key="year" :value="year">{{ year }}</option>
      </select>
    </label>
    <label>Make / manufacturer
      <SearchableCatalogField
        id="epa-make"
        :model-value="selectedMake"
        :options="makes"
        placeholder="Type to search makes"
        empty-message="No EPA make match; choose a suggested make."
        :max-length="80"
        @update:model-value="handleEpaMakeInput"
        @select="selectEpaMake"
        @commit="commitEpaMake"
      />
    </label>
    <label>Model
      <SearchableCatalogField
        id="epa-model"
        :model-value="selectedModel"
        :options="models"
        placeholder="Type to search models"
        empty-message="No EPA model match; choose a suggested model."
        :max-length="100"
        @update:model-value="handleEpaModelInput"
        @select="selectEpaModel"
        @commit="commitEpaModel"
      />
    </label>
    <label>Variant / trim<input v-model="variant" maxlength="80" placeholder="e.g. RS, Sport, V" required @input="updateVariant" /></label>
    <label>Version / engine and transmission
      <select v-model.number="selectedEpaId" required :disabled="busy || !options.length" @change="selectOption">
        <option value="" disabled>Select engine and transmission</option>
        <option v-for="option in options" :key="option.epaId" :value="option.epaId">{{ option.label }}</option>
      </select>
    </label>
    <p v-if="busy" class="vehicle-selector-status" role="status">Loading vehicle catalog…</p>
    <p v-if="errorMessage" class="vehicle-selector-status is-error" role="alert">{{ errorMessage }}</p>
    <p v-if="vehicleDetails" class="vehicle-selector-status">
      <strong>{{ category }}:</strong> {{ vehicleDetails.type }} · {{ vehicleDetails.fuelType }} · {{ vehicleDetails.fuelEconomyKmL.toFixed(2) }} km/L (EPA)
    </p>
    <p class="vehicle-selector-disclaimer">
      Fuel economy is from the U.S. EPA test catalog. Philippine-market specifications and real-world results may differ.
    </p>
    </template>
  </div>
</template>
