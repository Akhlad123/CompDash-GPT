import { initDuckDB, query } from './duckdb'

const RMA_PARQUET_URL = `${import.meta.env.BASE_URL}fleet-data/rma_data.parquet?v=2`

export interface RmaLoadResult {
  count: number
  source: 'bundled' | 'file' | null
  error?: string
}

const CREATE_RMA_TABLE = `
  CREATE OR REPLACE TABLE rma AS
  SELECT
    CAST(site_id AS VARCHAR)          AS site_id,
    replacement_model                  AS replacement_model,
    returned_sku                       AS returned_sku,
    replacement_family                 AS replacement_family,
    returned_product_family            AS returned_product_family,
    returned_family_clean              AS returned_family_clean,
    rma_product_type                   AS rma_product_type,
    returned_part_type                 AS returned_part_type,
    state                              AS state,
    country                            AS country,
    region                             AS region,
    created_date                       AS created_date,
    rma_type                           AS rma_type,
    rma_quarter                        AS rma_quarter
  FROM read_parquet('rma_data.parquet')
`

let rmaLoadPromise: Promise<RmaLoadResult> | null = null

async function ingestRmaFromBuffer(
  db: Awaited<ReturnType<typeof initDuckDB>>,
  buffer: Uint8Array,
  source: 'bundled' | 'file'
): Promise<RmaLoadResult> {
  await db.registerFileBuffer('rma_data.parquet', buffer)

  const conn = await db.connect()
  try {
    console.log('[rmaDuckdb] Ingesting RMA table via read_parquet...')
    try {
      await conn.query(CREATE_RMA_TABLE)
    } catch (sqlErr) {
      console.warn('[rmaDuckdb] Column-specific SQL failed, falling back to SELECT *:', sqlErr)
      await conn.query(`CREATE OR REPLACE TABLE rma AS SELECT * FROM read_parquet('rma_data.parquet')`)
    }
    const countResult = await conn.query('SELECT COUNT(*) AS cnt FROM rma')
    const count = Number(countResult.toArray()[0]?.cnt ?? 0)
    console.log(`[rmaDuckdb] Loaded ${count} RMA rows from ${source}`)
    return { count, source }
  } finally {
    await conn.close()
  }
}

/**
 * Load RMA data from a user-provided parquet file. The file stays in the
 * browser's DuckDB-WASM virtual filesystem; no data is uploaded to any server.
 */
export async function loadRmaFromFile(file: File): Promise<RmaLoadResult> {
  const db = await initDuckDB()
  const buffer = new Uint8Array(await file.arrayBuffer())
  rmaLoadPromise = (async () => ingestRmaFromBuffer(db, buffer, 'file'))()
  return rmaLoadPromise
}

/**
 * Fetches the bundled rma_data.parquet from the public folder when available,
 * registers it with DuckDB-WASM, and ingests it into the `rma` table.
 * Safe to call multiple times; the fetch+ingest only runs once per app session
 * unless replaced by a user upload via loadRmaFromFile().
 */
export async function ensureRmaDataLoaded(): Promise<RmaLoadResult> {
  if (rmaLoadPromise) return rmaLoadPromise

  rmaLoadPromise = (async () => {
    const db = await initDuckDB()

    console.log('[rmaDuckdb] Fetching bundled rma_data.parquet...')
    try {
      const resp = await fetch(RMA_PARQUET_URL)
      if (!resp.ok) {
        return { count: 0, source: null, error: `Bundled rma_data.parquet not found (${resp.status}). Please upload the file.` }
      }
      const buffer = new Uint8Array(await resp.arrayBuffer())
      return await ingestRmaFromBuffer(db, buffer, 'bundled')
    } catch (err) {
      return { count: 0, source: null, error: err instanceof Error ? err.message : String(err) }
    }
  })()

  return rmaLoadPromise
}

export async function isRmaTableReady(): Promise<boolean> {
  try {
    const rows = await query<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM rma')
    return (rows[0]?.cnt ?? 0) > 0
  } catch {
    return false
  }
}
