CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'station', 'admin')),
  search_radius_km SMALLINT NOT NULL DEFAULT 25 CHECK (search_radius_km BETWEEN 5 AND 200),
  vehicle_category TEXT,
  vehicle_type TEXT,
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_variant TEXT,
  vehicle_version TEXT,
  vehicle_year SMALLINT,
  vehicle_fuel_type TEXT,
  vehicle_economy_km_l NUMERIC(6, 2),
  vehicle_epa_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS search_radius_km SMALLINT NOT NULL DEFAULT 25;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_category TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_type TEXT NOT NULL DEFAULT 'Sedan';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_vehicle_type_check;
ALTER TABLE users ALTER COLUMN vehicle_type DROP DEFAULT;
ALTER TABLE users ALTER COLUMN vehicle_type DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_make TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_model TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_variant TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_year SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_fuel_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_economy_km_l NUMERIC(6, 2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_epa_id INTEGER;
UPDATE users SET vehicle_type = NULL WHERE vehicle_type IN ('Motorcycle', 'Sedan', 'SUV', 'Pickup', 'Van');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_vehicle_year_check;
ALTER TABLE users ADD CONSTRAINT users_vehicle_year_check CHECK (vehicle_year IS NULL OR vehicle_year BETWEEN 1980 AND 2100);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_vehicle_economy_km_l_check;
ALTER TABLE users ADD CONSTRAINT users_vehicle_economy_km_l_check CHECK (vehicle_economy_km_l IS NULL OR vehicle_economy_km_l > 0);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_search_radius_km_check;
ALTER TABLE users ADD CONSTRAINT users_search_radius_km_check CHECK (search_radius_km BETWEEN 5 AND 200);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password'
  ) THEN
    ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
  END IF;
END $$;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'station', 'admin'));

CREATE TABLE IF NOT EXISTS stations (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stations_location_idx ON stations (latitude, longitude);
ALTER TABLE stations ADD COLUMN IF NOT EXISTS source_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS stations_source_ref_uidx ON stations (source_ref);

CREATE TABLE IF NOT EXISTS fuel_prices (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
  price NUMERIC(8, 2) NOT NULL CHECK (price > 0),
  source TEXT NOT NULL DEFAULT 'station' CHECK (source IN ('station', 'demo')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (station_id, fuel_type)
);

ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'station';

CREATE TABLE IF NOT EXISTS fuel_price_history (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
  previous_price NUMERIC(8, 2),
  new_price NUMERIC(8, 2) NOT NULL CHECK (new_price > 0 AND new_price <= 1000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fuel_price_history_latest_idx ON fuel_price_history (station_id, fuel_type, recorded_at DESC);

CREATE TABLE IF NOT EXISTS fuel_price_reports (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
  price NUMERIC(8, 2) NOT NULL CHECK (price > 0 AND price <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fuel_price_reports_latest_idx ON fuel_price_reports (station_id, fuel_type, created_at DESC);

CREATE TABLE IF NOT EXISTS user_fuel_expenses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('Unleaded', 'Diesel', 'Premium')),
  liters NUMERIC(8, 2) NOT NULL CHECK (liters > 0 AND liters <= 10000),
  price_per_liter NUMERIC(8, 2) NOT NULL CHECK (price_per_liter > 0 AND price_per_liter <= 1000),
  station_name TEXT,
  purchased_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_fuel_expenses_latest_idx ON user_fuel_expenses (user_id, purchased_at DESC, id DESC);

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
);

CREATE INDEX IF NOT EXISTS in_app_notifications_latest_idx ON in_app_notifications (user_id, created_at DESC);