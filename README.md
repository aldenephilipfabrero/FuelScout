# LowGas

LowGas is an Ionic Vue and Capacitor app for finding nearby gas stations, comparing fuel prices, and viewing driving directions. Station owners have individual accounts and can add, edit, and delete prices for their own station. The API uses Express, PostgreSQL, JWT sessions, and bcrypt password hashes. OpenStreetMap provides map tiles; OSRM provides driving routes.

## Requirements

- Node.js 22 or newer
- PostgreSQL 14 or newer

## Run locally

1. Install packages from the project root with `npm install`.
2. Create a PostgreSQL database named `lowgas`.
3. Copy `.env.example` to either the project root `.env` or `server/.env`. The server checks the project-root file first, then `server/.env`. Set `DATABASE_URL` and a random `JWT_SECRET` with at least 32 characters.
4. Apply the schema to PostgreSQL from the project root:

	```powershell
	npm run db:schema
	```

	This also upgrades the legacy account table so registration can store account roles and bcrypt password hashes.

5. Optionally load sample Makati-area stations and demo prices with `npm run db:seed`.
6. Run the web app and API together with `npm run dev:all`.
7. Open `http://localhost:5173`.

An account is required to use LowGas. Visitors must sign in or register as a driver or station owner before they can view stations, compare prices, or use system features. Administrator accounts sign in through the Admin role and must be created with the administrator setup command; public registration cannot create administrators. Authentication and system data require the API and PostgreSQL database to be available. Vehicle catalog endpoints remain available during registration so drivers can select their vehicle.

## Import nationwide station locations

The importer requires the Osmium command-line tool (`osmium --version` must work in PowerShell), a configured `.env`, and a reachable PostgreSQL database. From the project root, run:

```powershell
npm run db:import-osm -- "C:\Users\YOUR_NAME\Downloads\philippines-261008.osm.pbf"
```

Replace the path with the actual location of the downloaded PBF file. The importer filters OSM objects tagged `amenity=fuel`, stores station coordinates and available names/addresses, and can be run again to update those OSM records without duplicating them. It does not create fuel prices: OSM station locations are community-mapped and may be incomplete. Select **Pilipinas** in the app to view the imported nationwide locations; nearby search remains available too.

## Accounts and prices

Drivers and station owners register with an email and password. Driver registration asks for the broad vehicle kind (motorcycle, car/sedan, SUV, pickup/truck, van, or other) and the vehicle's year, make, model, variant/trim, and version. Non-motorcycle vehicles use the official [U.S. FuelEconomy.gov/EPA vehicle catalog](https://www.fueleconomy.gov/feg/ws/) where available; make and model fields provide searchable catalog suggestions as users type, and EPA combined MPG is converted to km/L for one-way route estimates. Motorcycles use the [NHTSA vPIC motorcycle catalog](https://vpic.nhtsa.dot.gov/api/) for year, make, and model suggestions; those fields also accept custom entries when a motorcycle is not listed. Variant/trim and engine/version are entered manually. The NHTSA catalog represents U.S.-market vehicles, so Philippine-market motorcycles may be missing. It does not provide motorcycle fuel-economy ratings; LowGas uses a clearly labeled typical estimate of 35 km/L for motorcycles. Actual consumption varies with the specific vehicle and driving conditions, so all route fuel estimates are approximate. Drivers can select or update their vehicle in their profile. Existing accounts need to select a vehicle to enable estimates.

Station-owner registrations are submitted as applications. An administrator must approve an application before LowGas creates the station-owner account and station listing; pending applications cannot sign in or appear in station search. Administrators can approve or reject applications in the Applications section. After approval, owners can use device location or enter station coordinates, then add, edit, and delete fuel prices for their linked station. A station owner can also claim an unclaimed imported OSM station; this is a self-claim and does not independently verify identity or ownership.

At sign-in, choose Driver, Station owner, or Admin; the API verifies that the selected account type matches the authenticated PostgreSQL account and does not grant roles based on the selection. Driver accounts open a dedicated dashboard, with account details and editable profile settings available from the dashboard tab and initials avatar. Users can update their name and email, change their password, and save their 5–200 km search radius to PostgreSQL. Selecting a station and starting **Navigate live** uses device GPS to show changing direct distance and GPS accuracy, draw a driving route, and refresh the estimated road distance and travel time as the driver moves. Live navigation requires location permission and an internet connection; the direct GPS distance is separate from the road-route estimate. Open station maps refresh from PostgreSQL every 60 seconds. Signed-in users can submit community price reports; reports are labeled unverified, limited to 10 per user every 10 minutes, and are not substituted for owner-managed prices. Password changes require the current password; passwords are hashed and never stored in the browser profile.

Price Watch shows the lowest current owner-managed price and station for each fuel type; select a card to open that station on the map. It also summarizes average and observed low/high prices and changes from recorded owner updates. A decrease is labeled a rollback; an increase is labeled an increase. Driver accounts receive a persistent in-app notification for each registered-station price increase or rollback. The national reference links directly to the DOE Oil Monitor for its latest advisory; station prices remain separately sourced from registered station owners. Community submissions are not shown in Price Watch. Seeded demo prices are excluded. Without station-owner submissions, no current market price is available; OSM does not provide fuel prices.

The driver dashboard also lets each account keep a personal fuel-expense log with fuel type, liters, price per liter, purchase date, and optional station name. Expense records are private to the account that created them and can be deleted from the dashboard.

## Administrator dashboard

The admin dashboard is available only to accounts with the `admin` role. It reads from the same PostgreSQL database and provides account and station counts, current-price/history totals, and community report totals. Administrators can search and edit user contact details, edit or delete stations, add/update/delete current fuel prices (price changes are recorded in the existing history table), and review/delete community price reports. Deleting a station also deletes its linked prices and reports; deleting a non-admin user removes their account and owned station according to the database foreign-key rules. Administrator accounts cannot be edited or deleted from the dashboard.

After applying the schema, create a dedicated administrator account from the project root using the interactive setup:

```powershell
npm run admin:setup
```

Enter the admin name, email, and a password of at least 12 characters when prompted. The password is hidden while typing. The command hashes it with bcrypt and creates or promotes the account matching that email, so you can use it to reset an existing admin password too. Sign in with that account and choose **Admin**; the **Admin** section will appear in the sidebar. Public registration cannot create administrator accounts. Run `npm run db:schema` first to migrate an existing database to the admin role.

## Mobile builds

Capacitor is configured in `capacitor.config.ts`, and the Android platform is included in this project. Install Android Studio with its Android SDK and a compatible JDK, then create a debug APK from Windows in the project root:

```powershell
npm run android:apk
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. You can install this debug APK on an Android device for testing. To open the native project in Android Studio, run `npm run android:open`. After changing the web app, rerun `npm run android:apk` to rebuild and sync the APK.

The app's API must be reachable over HTTPS from the device; `localhost` on a phone refers to the phone, not your development computer. Set `VITE_API_URL` to the deployed API base URL before building the APK. Android declares coarse and fine location permissions for geolocation; install the rebuilt APK and grant location access when prompted.

The Android application ID is `com.lowgas.app`. Android treats this as a separate app from older `com.fuelscout.app` builds, so install LowGas separately and sign in again.

## Deploy online with Render

The `render.yaml` Blueprint defines a PostgreSQL database, an Express API, and a static web app. To deploy it, push this project to a Git provider, then create a new Blueprint in Render from that repository and review the services before confirming. The source is not uploaded by these local setup steps; deploying through Render will make the repository available to that provider.

The LowGas web app uses the existing API and database resources so current accounts and station data remain available. The API allows requests from both the LowGas and legacy web origins.

The Blueprint configures `VITE_API_URL` to use the existing API at `https://fuelscout-api.onrender.com/api`; the app itself is branded LowGas. Use that API URL when building the APK:

```powershell
$env:VITE_API_URL = 'https://fuelscout-api.onrender.com/api'
npm run android:apk
```

The Android APK build requires Android Studio, its SDK, and a compatible JDK installed locally. The API service applies the database schema when it starts. Create any administrator account separately for the deployed database; local accounts are not automatically copied to Render.

To provision an administrator on Render, temporarily set `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` on the API service, then deploy. Startup creates or promotes that account in the Render database. After confirming the deployment succeeds, remove all three variables and redeploy; the account remains in the database, and later restarts won't reset its password. Do not commit administrator credentials to the repository.
