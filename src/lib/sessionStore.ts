import { openDB } from 'idb'
import type { TelemetryRow } from '@/lib/schema'
import type { InverterInfo, DateRange } from '@/store/dataStore'

const DB_NAME = 'compdash'
const DB_VERSION = 1
const STORE_NAME = 'sessions'
const SESSION_KEY = 'compdash_session'

interface SessionData {
  rows: TelemetryRow[]
  sites: string[]
  inverters: InverterInfo[]
  dateRange: { from: string; to: string } | null
  savedAt: string
}

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    },
  })
}

export async function saveSession(
  rows: TelemetryRow[],
  sites: string[],
  inverters: InverterInfo[],
  dateRange: DateRange | null
): Promise<void> {
  const db = await getDB()
  const data: SessionData = {
    rows,
    sites,
    inverters,
    dateRange: dateRange
      ? { from: dateRange.from.toISOString(), to: dateRange.to.toISOString() }
      : null,
    savedAt: new Date().toISOString(),
  }
  await db.put(STORE_NAME, data, SESSION_KEY)
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const db = await getDB()
    const data = await db.get(STORE_NAME, SESSION_KEY)
    return (data as SessionData) ?? null
  } catch {
    return null
  }
}

export async function clearSession(): Promise<void> {
  const db = await getDB()
  await db.delete(STORE_NAME, SESSION_KEY)
}

export async function hasSession(): Promise<boolean> {
  try {
    const db = await getDB()
    const data = await db.get(STORE_NAME, SESSION_KEY)
    return data != null
  } catch {
    return false
  }
}
