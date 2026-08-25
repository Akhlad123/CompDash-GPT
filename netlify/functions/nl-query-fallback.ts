// Netlify serverless function — the ONLY place the OpenAI API key is used.
// Proxies natural-language -> SQL generation for the `fleet` table when the
// client-side rule-based parser (nlQueryParser.ts) returns low confidence.
// Per CompDashGPT.windsurfrules.txt rules 10-12:
//   - rule-based parsing is tried first, this is only a fallback
//   - LLM-generated SQL is re-validated client-side before execution
//   - the API key never touches client-side code/bundles/localStorage

import type { Handler } from '@netlify/functions'

const FLEET_SCHEMA = `
Table: fleet
Columns:
  site_id                 VARCHAR   Site identifier
  country                 VARCHAR
  region_bundle           VARCHAR   High-level region grouping
  tss_region               VARCHAR
  tss_country              VARCHAR
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
  irr_ann_kwh_m2_month    DOUBLE    Average solar irradiance, kWh/m^2/month
`.trim()

const SYSTEM_PROMPT_HEADER = `You are a SQL generator for a single DuckDB table called "fleet". Given a natural-language question, output ONLY a JSON object of the form:
{"sql": "<single SELECT statement>", "explanation": "<one sentence describing what the query does>"}

${FLEET_SCHEMA}

Rules:
- The SQL MUST be a single SELECT statement (no semicolons, no CTEs that create objects, no multiple statements).
- ONLY reference the "fleet" table. Never reference any other table.
- NEVER use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH, DETACH, COPY, EXPORT, IMPORT, PRAGMA, CALL, GRANT, REVOKE, MERGE, VACUUM, or LOAD.
- Prefer an explicit column list over SELECT *.
- For ranked/listing questions, include a LIMIT (default 20, max 500).
- For aggregate questions ("how many", "total", "average"), return the aggregate only (no LIMIT needed).
- Use single-quoted string literals, matching the known distinct values given below EXACTLY (case-sensitive) when filtering categorical columns.
- If the question is ambiguous or unanswerable with this schema, still return your best-effort SELECT with a clear explanation.
- Output ONLY the JSON object. No markdown, no code fences, no extra commentary.`

interface RequestBody {
  question?: string
  dictionaries?: Record<string, string[]>
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  const ollamaBase = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')
  const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'
  const useOllama = !apiKey

  let question: string
  let dictionaries: Record<string, string[]> = {}
  try {
    const parsedBody = JSON.parse(event.body || '{}') as RequestBody
    if (!parsedBody.question || typeof parsedBody.question !== 'string') {
      return jsonResponse(400, { error: 'Missing "question" in request body.' })
    }
    question = parsedBody.question
    dictionaries = parsedBody.dictionaries ?? {}
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON request body.' })
  }

  const dictText = Object.entries(dictionaries)
    .filter(([, vals]) => Array.isArray(vals) && vals.length > 0)
    .map(([col, vals]) => `  ${col}: ${vals.slice(0, 80).join(', ')}`)
    .join('\n')

  const systemPrompt = dictText
    ? `${SYSTEM_PROMPT_HEADER}\n\nKnown distinct values for filterable columns:\n${dictText}`
    : SYSTEM_PROMPT_HEADER

  try {
    let content: string | undefined

    if (useOllama) {
      // --- Ollama local path (free, no API key) ---
      let ollamaResp: Response
      try {
        ollamaResp = await fetch(`${ollamaBase}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            stream: false,
            format: 'json',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: question },
            ],
          }),
        })
      } catch (fetchErr) {
        return jsonResponse(503, {
          error: `Cannot reach Ollama at ${ollamaBase}. Is it running? Start it with: ollama serve`,
        })
      }

      if (!ollamaResp.ok) {
        const errText = await ollamaResp.text()
        return jsonResponse(502, { error: `Ollama error (${ollamaResp.status}): ${errText.slice(0, 500)}` })
      }

      const ollamaData = (await ollamaResp.json()) as {
        message?: { content?: string }
      }
      content = ollamaData?.message?.content
    } else {
      // --- OpenAI path (requires OPENAI_API_KEY) ---
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
          ],
        }),
      })

      if (!resp.ok) {
        const errText = await resp.text()
        return jsonResponse(502, { error: `OpenAI API error (${resp.status}): ${errText.slice(0, 500)}` })
      }

      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      content = data?.choices?.[0]?.message?.content
    }

    if (!content || typeof content !== 'string') {
      return jsonResponse(502, { error: 'Empty response from LLM.' })
    }

    let parsed: { sql?: string; explanation?: string }
    try {
      parsed = JSON.parse(content)
    } catch {
      return jsonResponse(502, { error: 'LLM did not return valid JSON.' })
    }

    if (!parsed.sql || typeof parsed.sql !== 'string') {
      return jsonResponse(502, { error: 'LLM response did not include SQL.' })
    }

    return jsonResponse(200, {
      sql: parsed.sql,
      explanation: parsed.explanation ?? 'LLM-generated query.',
    })
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) })
  }
}
