import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const projectEnv = resolve(serverDirectory, '../.env')
const serverEnv = resolve(serverDirectory, '.env')
const envPath = [projectEnv, serverEnv].find(existsSync)

config(envPath ? { path: envPath } : {})
