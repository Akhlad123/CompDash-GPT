import { initDuckDB, query } from './duckdb'

const FLEET_PARQUET_URL = `${import.meta.env.BASE_URL}fleet-data/fleet_data.parquet?v=3`

export interface FleetLoadResult {
  count: number
  source: 'bundled' | 'file' | null
  error?: string
}

// Parquet is used instead of CSV because this dataset accumulates for 2-3
// years of quarterly history (raw source can reach ~950 MB). Parquet's
// columnar + dictionary + zstd encoding compresses the low-cardinality
// categorical columns here ~6x better than CSV (measured: 32.1 MB CSV vs
// 5.4 MB Parquet for the same 157,788 rows), keeping the browser-memory
// footprint safe even as the dataset grows. See scripts/prepare_fleet_data.py.
const CREATE_FLEET_TABLE = `
  CREATE OR REPLACE TABLE fleet AS
  SELECT
    CAST(site_id AS VARCHAR)          AS site_id,
    country                            AS country,
    region_bundle                      AS region_bundle,
    tss_region                         AS tss_region,
    tss_country                        AS tss_country,
    device_type_name                   AS device_type_name,
    product_type                       AS product_type,
    pv_module_make                     AS pv_module_make,
    pv_module_model                    AS pv_module_model,
    CAST(voc AS DOUBLE)                AS voc,
    CAST(isc AS DOUBLE)                AS isc,
    module_wafer                       AS module_wafer,
    CAST(stc_rating2 AS DOUBLE)        AS stc_rating2,
    CAST(stc_mwdc AS DOUBLE)           AS stc_mwdc,
    CAST(mwac AS DOUBLE)               AS mwac,
    CAST(dc_ac_ratio AS DOUBLE)        AS dc_ac_ratio,
    CAST(unit_count AS INTEGER)        AS unit_count,
    power_bucket                       AS power_bucket,
    power_block                        AS power_block,
    quarter_first_interval             AS quarter_first_interval,
    quarter_device_created             AS quarter_device_created,
    city                                AS city,
    state                               AS state,
    zip_code                            AS zip_code,
    CAST(latitude AS DOUBLE)            AS latitude,
    CAST(longitude AS DOUBLE)           AS longitude,
    CAST(irr_ann_kwh_m2_month AS DOUBLE)       AS irr_ann_kwh_m2_month,
    circuit_phase                              AS circuit_phase,
    production_eim_config                      AS production_eim_config,
    consumption_eim_config                     AS consumption_eim_config,
    model_name                                 AS model_name
  FROM read_parquet('fleet_data.parquet')
`

let fleetLoadPromise: Promise<FleetLoadResult> | null = null

async function ingestFleetFromBuffer(
  db: Awaited<ReturnType<typeof initDuckDB>>,
  buffer: Uint8Array,
  source: 'bundled' | 'file'
): Promise<FleetLoadResult> {
  await db.registerFileBuffer('fleet_data.parquet', buffer)

  const conn = await db.connect()
  try {
    console.log('[fleetDuckdb] Ingesting fleet table via read_parquet...')
    try {
      await conn.query(CREATE_FLEET_TABLE)
    } catch (sqlErr) {
      // Fallback: old parquet may lack new columns (voc, isc, pv_module_model)
      console.warn('[fleetDuckdb] Column-specific SQL failed, falling back to SELECT *:', sqlErr)
      await conn.query(`CREATE OR REPLACE TABLE fleet AS SELECT * FROM read_parquet('fleet_data.parquet')`)
    }
    const countResult = await conn.query('SELECT COUNT(*) AS cnt FROM fleet')
    const count = Number(countResult.toArray()[0]?.cnt ?? 0)
    console.log(`[fleetDuckdb] Loaded ${count} fleet rows from ${source}`)
    return { count, source }
  } finally {
    await conn.close()
  }
}

/**
 * Load fleet data from a user-provided parquet file. The file stays in the
 * browser's DuckDB-WASM virtual filesystem; no data is uploaded to any server.
 */
export async function loadFleetFromFile(file: File): Promise<FleetLoadResult> {
  const db = await initDuckDB()
  const buffer = new Uint8Array(await file.arrayBuffer())
  fleetLoadPromise = (async () => ingestFleetFromBuffer(db, buffer, 'file'))()
  return fleetLoadPromise
}

/**
 * Fetches the bundled fleet_data.parquet from the public folder when available,
 * registers it with DuckDB-WASM, and ingests it into the `fleet` table.
 * Safe to call multiple times; the underlying fetch+ingest only runs once per
 * app session unless replaced by a user upload via loadFleetFromFile().
 */
export async function ensureFleetDataLoaded(): Promise<FleetLoadResult> {
  if (fleetLoadPromise) return fleetLoadPromise

  fleetLoadPromise = (async () => {
    const db = await initDuckDB()

    console.log('[fleetDuckdb] Fetching bundled fleet_data.parquet...')
    try {
      const resp = await fetch(FLEET_PARQUET_URL)
      if (!resp.ok) {
        return { count: 0, source: null, error: `Bundled fleet_data.parquet not found (${resp.status}). Please upload the file.` }
      }
      const buffer = new Uint8Array(await resp.arrayBuffer())
      return await ingestFleetFromBuffer(db, buffer, 'bundled')
    } catch (err) {
      return { count: 0, source: null, error: err instanceof Error ? err.message : String(err) }
    }
  })()

  return fleetLoadPromise
}

export async function isFleetTableReady(): Promise<boolean> {
  try {
    const rows = await query<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM fleet')
    return (rows[0]?.cnt ?? 0) > 0
  } catch {
    return false
  }
}

export async function getDistinctFleetValues(column: string): Promise<string[]> {
  const rows = await query<{ v: string }>(
    `SELECT DISTINCT ${column} AS v FROM fleet WHERE ${column} IS NOT NULL ORDER BY v`
  )
  return rows.map((r) => r.v)
}

export async function getFleetQuarters(): Promise<string[]> {
  return getDistinctFleetValues('quarter_first_interval')
}
