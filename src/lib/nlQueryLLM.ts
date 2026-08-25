// Client-side LLM — calls a local Ollama instance directly.
// All queries are routed here first; rule-based parsers are offline-only fallback.
// Ollama runs on localhost:11434 with CORS enabled by default.
// LLM-generated SQL is re-validated client-side before execution.

import type { ParsedQuery } from './nlQueryParser'
import type { QueryTarget } from './nlQueryRouter'

const OLLAMA_BASE = 'http://localhost:11434'
// Configurable via .env.local: VITE_OLLAMA_MODEL=qwen3:14b
const OLLAMA_MODEL: string =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_OLLAMA_MODEL ??
  'qwen3:14b'

const FLEET_SCHEMA = `Table: fleet
Columns:
  site_id                 VARCHAR   Site identifier
  country                 VARCHAR
  region_bundle           VARCHAR   High-level region grouping
  tss_region              VARCHAR
  tss_country             VARCHAR
  device_type_name        VARCHAR
  product_type            VARCHAR   e.g. IQ8, IQ8P, IQ8M microinverter model
  pv_module_make          VARCHAR
  module_wafer            VARCHAR   Solar cell wafer size code, e.g. G12R, M10
  stc_rating2             DOUBLE    Module wattage (W)
  stc_mwdc                DOUBLE    STC capacity, MWdc
  mwac                    DOUBLE    AC capacity, MWac
  dc_ac_ratio             DOUBLE
  unit_count              INTEGER   Microinverter unit count
  power_bucket            VARCHAR
  power_block             VARCHAR
  quarter_first_interval  VARCHAR   Quarter of first telemetry interval, e.g. 2024-Q3
  quarter_device_created  VARCHAR
  city                    VARCHAR
  state                   VARCHAR
  zip_code                VARCHAR
  latitude                DOUBLE
  longitude               DOUBLE
  irr_ann_kwh_m2_month    DOUBLE    Average solar irradiance, kWh/m^2/month`

const FLEET_SYSTEM_PROMPT = `You are a precise SQL generator for a single DuckDB table called "fleet". Given a natural-language question, output ONLY a JSON object with this exact shape:
{"sql":"<single SELECT statement>","explanation":"<one sentence>","confidence":"high|medium|low","unanswerable":false,"caveat":"<optional note or empty string>"}

${FLEET_SCHEMA}

Rules:
- SQL MUST be a single SELECT statement. No semicolons, no CTEs, no multiple statements.
- ONLY reference the "fleet" table.
- NEVER use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH, DETACH, COPY, EXPORT, IMPORT, PRAGMA, CALL, GRANT, REVOKE, MERGE, VACUUM, or LOAD.
- Prefer explicit column lists over SELECT *.
- For ranked/listing questions, always include LIMIT (default 20, max 500).
- For aggregates ("how many", "total", "average", "sum"), return only the aggregate — no LIMIT.
- String literals must match known distinct values EXACTLY (case-sensitive).
- DuckDB syntax: use ILIKE for case-insensitive matching, STRFTIME for date formatting, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col) for median.
- CRITICAL GROUP BY RULE: When SELECT contains any aggregate function (SUM, COUNT, AVG, MIN, MAX) AND non-aggregate columns, ALL non-aggregate SELECT columns AND any bare ORDER BY columns MUST appear in the GROUP BY clause. Example: SELECT region, SUM(units) FROM fleet GROUP BY region ORDER BY SUM(units) DESC — NOT ORDER BY units.
- Set "confidence":"low" when you are unsure about a column value or must guess.
- Set "unanswerable":true when the question requires data NOT in this schema (e.g. revenue, pricing, installation date, live sensor data). Still emit a best-effort SQL.
- Set "caveat" to a short note when data may be incomplete or ambiguous (else empty string "").
- Output ONLY the JSON object. No markdown, no code fences, no extra text.

Examples:
Q: "How many sites in Germany?"
A: {"sql":"SELECT COUNT(DISTINCT site_id) AS site_count FROM fleet WHERE tss_country = 'Germany'","explanation":"Counts distinct sites in Germany","confidence":"high","unanswerable":false,"caveat":""}

Q: "Top 5 sites with most units in North America in 2025-Q4 with G12R wafer"
A: {"sql":"SELECT site_id, city, state, SUM(unit_count) AS total_units FROM fleet WHERE tss_region = 'NA' AND quarter_first_interval = '2025-Q4' AND module_wafer = 'G12R' GROUP BY site_id, city, state ORDER BY total_units DESC LIMIT 5","explanation":"Top 5 NA sites by unit count with G12R wafer in Q4 2025","confidence":"high","unanswerable":false,"caveat":""}

Q: "Average DC/AC ratio by region in 2026?"
A: {"sql":"SELECT tss_region, AVG(dc_ac_ratio) AS avg_dc_ac, SUM(unit_count) AS total_units FROM fleet WHERE LEFT(quarter_first_interval,4) = '2026' GROUP BY tss_region ORDER BY avg_dc_ac DESC","explanation":"Average DC/AC ratio per TSS region for all 2026 quarters","confidence":"high","unanswerable":false,"caveat":"Weighted by row count, not unit_count — for unit-weighted result, use SUM(dc_ac_ratio*unit_count)/SUM(unit_count)"}`

const TELEMETRY_SCHEMA = `Table: telemetry
Columns:
  serial_number   VARCHAR   12-digit microinverter serial number
  site_id         VARCHAR   Site identifier
  timestamp       TIMESTAMP Reading timestamp (5 or 15-min granularity)
  local_date      VARCHAR   Date of reading (YYYY-MM-DD)
  ac_voltage      DOUBLE    AC voltage (V)
  ac_frequency    DOUBLE    AC frequency (Hz)
  temperature_f   DOUBLE    Inverter temperature (Fahrenheit)
  dc_current      DOUBLE    DC current from PV module (A)
  dc_voltage      DOUBLE    DC voltage from PV module (V)
  duration        DOUBLE    Reporting interval (seconds)
  energy_produced DOUBLE    Energy produced in interval (Wh)
  sku_name        VARCHAR   Microinverter model (e.g. IQ8P, IQ8HC)

Computed expressions (use these in queries, they are NOT stored columns):
  DC Power (W):     dc_current * dc_voltage
  AC Power (W):     CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END
  Temperature (°C): (temperature_f - 32) * 5.0 / 9.0`

const TELEMETRY_SYSTEM_PROMPT = `You are a precise SQL generator for a single DuckDB table called "telemetry" containing solar microinverter time-series data. Given a natural-language question, output ONLY a JSON object with this exact shape:
{"sql":"<single SELECT statement>","explanation":"<one sentence>","confidence":"high|medium|low","unanswerable":false,"caveat":"<optional note or empty string>"}

${TELEMETRY_SCHEMA}

Rules:
- SQL MUST be a single SELECT statement. No semicolons, no CTEs, no multiple statements.
- ONLY reference the "telemetry" table.
- NEVER use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH, DETACH, COPY, EXPORT, IMPORT, PRAGMA, CALL, GRANT, REVOKE, MERGE, VACUUM, or LOAD.
- Prefer explicit column lists over SELECT *.
- For ranked/listing questions, always include LIMIT (default 20, max 500).
- For aggregates, return only the aggregate — no LIMIT.
- DuckDB date functions: DATE_TRUNC('hour', timestamp), CAST(timestamp AS DATE), EXTRACT(HOUR FROM timestamp).
- DC power = dc_current * dc_voltage. AC power = CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END. Temperature °C = (temperature_f - 32) * 5.0 / 9.0.
- For daily aggregates, group by local_date or CAST(timestamp AS DATE).
- Set "confidence":"low" when guessing about serial numbers, site IDs, or date ranges.
- Set "unanswerable":true when the question requires data not in telemetry schema (e.g. fleet region, module wafer).
- Set "caveat" to a short note when relevant, else "".
- Output ONLY the JSON object. No markdown, no code fences, no extra text.

Examples:
Q: "Which inverter produced the most energy?"
A: {"sql":"SELECT serial_number, SUM(energy_produced) AS total_energy_wh FROM telemetry GROUP BY serial_number ORDER BY total_energy_wh DESC LIMIT 1","explanation":"Inverter with the highest total energy production","confidence":"high","unanswerable":false,"caveat":""}

Q: "Inverters not crossing Vmp 40V"
A: {"sql":"SELECT serial_number, AVG(dc_voltage) AS avg_dc_voltage FROM telemetry GROUP BY serial_number HAVING AVG(dc_voltage) < 40 ORDER BY avg_dc_voltage ASC LIMIT 50","explanation":"Inverters whose average DC voltage is below 40V (Vmp threshold)","confidence":"high","unanswerable":false,"caveat":"Uses average DC voltage as proxy for Vmp"}

Q: "Daily energy trend"
A: {"sql":"SELECT local_date, SUM(energy_produced) AS total_energy_wh FROM telemetry GROUP BY local_date ORDER BY local_date","explanation":"Total energy produced per day across all inverters","confidence":"high","unanswerable":false,"caveat":""}`

const CROSS_TABLE_SYSTEM_PROMPT = `You are a precise SQL generator for two DuckDB tables: "fleet" and "telemetry". They share site_id as a join key. Given a natural-language question, output ONLY a JSON object with this exact shape:
{"sql":"<single SELECT statement>","explanation":"<one sentence>","confidence":"high|medium|low","unanswerable":false,"caveat":"<optional note or empty string>"}

${FLEET_SCHEMA}

${TELEMETRY_SCHEMA}

Rules:
- SQL MUST be a single SELECT statement. No semicolons, no CTEs, no multiple statements.
- ONLY reference "fleet" and/or "telemetry" tables.
- NEVER use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, or other DDL/DML.
- JOIN fleet and telemetry ON site_id when both are needed. Use table aliases f and t.
- Prefer explicit column lists: f.col, t.col.
- DC power = t.dc_current * t.dc_voltage. AC power = CASE WHEN t.duration > 0 THEN (t.energy_produced * 3600.0) / t.duration ELSE 0 END.
- Include LIMIT for listing queries (default 20, max 500).
- Set "unanswerable":true only if question is truly outside both schemas.
- Output ONLY the JSON object. No markdown, no code fences, no extra text.`

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DataStats {
  totalRows?: number
  siteCount?: number
  inverterCount?: number
  dateFrom?: string
  dateTo?: string
}

export interface ConversationTurn {
  question: string
  sql: string
  /** Short summary of the result, e.g. "→ 42 rows, top: NA = 408,903 units" */
  resultSummary?: string
}

// Shape we expect back from the LLM
interface LLMResponse {
  sql?: string
  explanation?: string
  confidence?: 'high' | 'medium' | 'low'
  unanswerable?: boolean
  caveat?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  target: QueryTarget,
  dictionaries: Record<string, string[]>,
  dataStats?: DataStats,
): string {
  const basePrompt =
    target === 'both' ? CROSS_TABLE_SYSTEM_PROMPT
    : target === 'telemetry' ? TELEMETRY_SYSTEM_PROMPT
    : FLEET_SYSTEM_PROMPT

  // Cap at 20 values per column to keep prompt short and inference fast
  const dictText = Object.entries(dictionaries)
    .filter(([, vals]) => Array.isArray(vals) && vals.length > 0)
    .map(([col, vals]) => `  ${col}: ${vals.slice(0, 20).join(', ')}`)
    .join('\n')

  let prompt = dictText
    ? `${basePrompt}\n\nKnown distinct values for filterable columns:\n${dictText}`
    : basePrompt

  if (dataStats) {
    const parts: string[] = []
    if (dataStats.totalRows) parts.push(`Total rows: ~${dataStats.totalRows.toLocaleString()}`)
    if (dataStats.siteCount) parts.push(`Sites: ${dataStats.siteCount}`)
    if (dataStats.inverterCount) parts.push(`Inverters: ${dataStats.inverterCount}`)
    if (dataStats.dateFrom && dataStats.dateTo)
      parts.push(`Date range: ${dataStats.dateFrom} to ${dataStats.dateTo}`)
    if (parts.length > 0) prompt += `\n\nDataset stats:\n  ${parts.join('\n  ')}`
  }

  return prompt
}

async function callOllama(messages: { role: string; content: string }[]): Promise<string> {
  let resp: Response
  try {
    resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        messages,
      }),
    })
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${OLLAMA_BASE}. Make sure Ollama is running (ollama serve) and you have pulled the model (ollama pull ${OLLAMA_MODEL}).`
    )
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Ollama error (${resp.status}): ${errText.slice(0, 300)}`)
  }

  const data = (await resp.json()) as { message?: { content?: string } }
  const content = data?.message?.content
  if (!content || typeof content !== 'string') throw new Error('Ollama returned an empty response.')
  return content
}

function parseLLMContent(content: string): LLMResponse {
  // Strip markdown code fences if the model wrapped anyway
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned) as LLMResponse
  } catch {
    // Try to extract first { ... } block
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { return JSON.parse(m[0]) as LLMResponse } catch { /* fall through */ }
    }
    throw new Error('Ollama did not return valid JSON. Try rephrasing your question.')
  }
}

// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

/**
 * Calls Ollama to generate SQL from a natural-language question.
 * Returns a ParsedQuery with confidence, unanswerable flag, and caveat.
 * Callers MUST still run SQL through validateFleetSql() before execution.
 */
export async function fetchLLMFallback(
  question: string,
  dictionaries: Record<string, string[]>,
  target: QueryTarget = 'fleet',
  dataStats?: DataStats,
  conversationHistory?: ConversationTurn[],
): Promise<ParsedQuery> {
  const systemPrompt = buildSystemPrompt(target, dictionaries, dataStats)

  // Last 5 turns with result summaries for richer follow-up context
  const historyMessages = (conversationHistory ?? [])
    .slice(-5)
    .flatMap((turn) => [
      { role: 'user' as const, content: turn.question },
      {
        role: 'assistant' as const,
        content: JSON.stringify({
          sql: turn.sql,
          explanation: turn.resultSummary ?? 'Previous query.',
          confidence: 'high',
          unanswerable: false,
          caveat: '',
        }),
      },
    ])

  const content = await callOllama([
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: question },
  ])

  const parsed = parseLLMContent(content)

  if (!parsed.sql || typeof parsed.sql !== 'string') {
    throw new Error('Ollama response did not include SQL.')
  }

  const confidence: 'high' | 'medium' | 'low' =
    parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : 'medium'

  return {
    sql: parsed.sql.trim(),
    confidence,
    explanation: parsed.explanation ?? 'LLM-generated query.',
    matchedEntities: {},
    caveat: parsed.caveat || undefined,
    unanswerable: parsed.unanswerable === true,
  }
}

/**
 * Retries a failed SQL by sending the DuckDB error back to Ollama.
 * Used once automatically when the first SQL attempt throws on execution.
 */
export async function retryWithError(
  originalQuestion: string,
  failedSql: string,
  duckdbError: string,
  dictionaries: Record<string, string[]>,
  target: QueryTarget = 'fleet',
): Promise<ParsedQuery> {
  const systemPrompt = buildSystemPrompt(target, dictionaries)
  const fixRequest = `The following SQL failed in DuckDB with this error:\n\nSQL: ${failedSql}\n\nError: ${duckdbError}\n\nPlease fix the SQL for the original question: "${originalQuestion}". Return only the corrected JSON.`

  const content = await callOllama([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: originalQuestion },
    { role: 'assistant', content: JSON.stringify({ sql: failedSql, explanation: '', confidence: 'medium', unanswerable: false, caveat: '' }) },
    { role: 'user', content: fixRequest },
  ])

  const parsed = parseLLMContent(content)
  if (!parsed.sql || typeof parsed.sql !== 'string') throw new Error('Retry did not return valid SQL.')

  return {
    sql: parsed.sql.trim(),
    confidence: 'medium',
    explanation: parsed.explanation ?? 'Auto-corrected query.',
    matchedEntities: {},
    caveat: parsed.caveat ?? 'Auto-corrected after SQL execution error.',
    unanswerable: false,
  }
}

/**
 * Sends query results to Ollama for a brief natural-language interpretation.
 * Streams tokens via onToken callback so the UI can render progressively.
 * Calls onDone when complete. Never throws — insight is optional.
 */
export async function fetchInsight(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  target: QueryTarget,
  onToken: (token: string) => void,
  onDone: () => void,
): Promise<void> {
  const sampleRows = rows.slice(0, 10)
  const resultPreview = JSON.stringify(sampleRows, null, 0).slice(0, 1500)
  const domain = target === 'telemetry' ? 'solar microinverter telemetry' : 'solar fleet'

  const prompt = `You are a ${domain} data analyst. The user asked: "${question}"
The SQL was: ${sql}
The query returned ${rows.length} row(s). Preview:
${resultPreview}

Write 1-3 sentences of insight. Focus on:
- Key findings (highest/lowest values, trends, anomalies)
- Domain interpretation (solar: voltage thresholds, clipping, temperature, DC/AC sizing)
- Actionable takeaways if any
Be concise and factual. Do NOT repeat the question. Output ONLY the insight text, no JSON.`

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: true, prompt }),
    })
    if (!resp.ok || !resp.body) { onDone(); return }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      // Each chunk is a newline-delimited JSON object from Ollama streaming
      for (const line of chunk.split('\n').filter(Boolean)) {
        try {
          const obj = JSON.parse(line) as { response?: string; done?: boolean }
          if (obj.response) onToken(obj.response)
          if (obj.done) break
        } catch { /* partial line — ignore */ }
      }
    }
  } catch { /* insight is optional — never block main flow */ }
  finally { onDone() }
}

/**
 * When a query returns 0 rows, asks Ollama why — one sentence explanation.
 * Non-blocking; returns null on any failure.
 */
export async function fetchEmptyResultExplanation(
  question: string,
  sql: string,
  dictionaries: Record<string, string[]>,
): Promise<string | null> {
  const dictText = Object.entries(dictionaries)
    .filter(([, vals]) => Array.isArray(vals) && vals.length > 0)
    .map(([col, vals]) => `  ${col}: ${vals.slice(0, 20).join(', ')}`)
    .join('\n')

  const prompt = `A DuckDB SQL query returned 0 rows. Explain in ONE sentence why this might be, given the available data values below.\n\nQuestion: "${question}"\nSQL: ${sql}\n\nKnown values:\n${dictText}\n\nBe brief and specific. Output only the explanation sentence.`

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, prompt }),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { response?: string }
    return data?.response?.trim() || null
  } catch {
    return null
  }
}

/**
 * Fire-and-forget warmup ping to Ollama.
 * Call once on page mount so the model is loaded in memory
 * before the user submits their first real question.
 */
export function warmupOllama(): void {
  fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: 'hi', stream: false }),
  }).catch(() => { /* warmup is optional */ })
}

/** Exported for the model suggestion tooltip in the UI. */
export const currentOllamaModel = OLLAMA_MODEL
