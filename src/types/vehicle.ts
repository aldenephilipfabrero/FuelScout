export type VehicleCategory = 'Motorcycle' | 'Car / Sedan' | 'SUV' | 'Pickup / Truck' | 'Van' | 'Other'

export type VehicleRecord = {
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

export type VehicleCatalogOption = {
  label: string
  epaId: number
}

export type EpaVehicleDetails = Omit<VehicleRecord, 'category' | 'variant' | 'economySource'>
