// server/services/iptvDbSingleton.ts
import { env } from '../env.js'
import { openIptvDb, type IptvDb } from './iptvDb.js'

let cached: IptvDb | null = null

export function iptvDb(): IptvDb {
  if (!cached) cached = openIptvDb(env.IPTV_DB_PATH)
  return cached
}

export function closeIptvDb(): void {
  if (cached) {
    cached.close()
    cached = null
  }
}
