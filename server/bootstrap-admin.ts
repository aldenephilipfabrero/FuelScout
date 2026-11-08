import './config.js'

if (process.env.ADMIN_NAME || process.env.ADMIN_EMAIL || process.env.ADMIN_PASSWORD) {
  await import('./create-admin.js')
} else {
  console.log('No administrator bootstrap configured; skipping.')
}
