// Stage 1 — Analyst LLM: question → structured AnalysisRequest.
// The LLM NEVER generates SQL. It selects a tool and supplies typed params.
// All output is Zod-validated before any tool is dispatched.

import { z } from 'zod'
import type { LLMProvider } from './llmProvider'
import { buildLLMFieldList } from './semanticCatalog'
import { buildToolList } from './analyticsTools'

// ─── AnalysisRequest contract (Zod-validated) ─────────────────────────────────

export const AnalysisRequestSchema = z.object({
  intent: z.enum([
    'fleet_summary', 'site_summary', 'product_summary', 'region_summary', 'dc_ac_ratio',
    'energy_total', 'energy_compare', 'energy_per_inverter',
    'telemetry_stats', 'time_series', 'telemetry_compare',
    'clipping', 'inverter_utilization', 'anomaly_detect', 'inverter_drilldown',
    'site_analysis', 'microinverter_analysis',
    'nearby_sites',
    'fleet_search',
    'knowledge',
    'unanswerable',
  ]),
  tool: z.string(),
  metric: z.string().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  groupBy: z.array(z.string()).optional(),
  timeRange: z.object({ from: z.string(), to: z.string() }).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  aggregation: z.enum(['avg', 'sum', 'min', 'max', 'count', 'p50', 'p90', 'p95']).optional(),
  visualization: z.enum(['bar', 'line', 'scatter', 'histogram', 'table', 'kpi', 'heatmap', 'box']).optional(),
  products: z.array(z.string()).optional(),
  sites: z.array(z.string()).optional(),
  serials: z.array(z.string()).optional(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  caveat: z.string().optional(),
  unanswerable: z.boolean().optional(),
  requireModuleInfo: z.boolean().optional(),  // false when user says 'module data doesn’t matter'
})

export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(contextTable: 'fleet' | 'telemetry' | 'both'): string {
  const fields = buildLLMFieldList(contextTable === 'both' ? 'all' : contextTable)
  const tools = buildToolList()

  return `You are an analytics orchestrator for a solar microinverter fleet dashboard.
Your ONLY job is to analyze the user's question and output a JSON object describing which analytics tool to run and with what parameters.
You NEVER generate SQL. You NEVER invent numbers. You NEVER answer the question — only select the tool.

AVAILABLE TOOLS:
${tools}

DOMAIN FIELDS (use these exact names in your JSON):
${fields}

OUTPUT FORMAT — reply with ONLY valid JSON, no markdown, no prose:
{
  "intent": "<one of the intent values>",
  "tool": "<tool name from the list>",
  "metric": "<field name if applicable>",
  "filters": { "tssRegions": [...], "quarters": [...], "countries": [...], "skuNames": [...], "siteIds": [...] },
  "groupBy": ["<dimension1>", "<dimension2>"],
  "aggregation": "<avg|sum|min|max|count|p50|p90|p95>",
  "visualization": "<bar|line|scatter|histogram|table|kpi|heatmap|box>",
  "products": ["<sku1>", "<sku2>"],
  "sites": ["<site_id1>"],
  "serials": ["<serial_number1>"],
  "confidence": "<high|medium|low>",
  "caveat": "<optional note if question is ambiguous or out of scope>",
  "unanswerable": false
}

RULES:
1. If the question is about fleet units/sites/regions/wafer/product mix → use fleet tools.
2. If the question is about energy production, time series, temperature, voltage, current → use telemetry/energy tools.
3. If the question mentions clipping, limiting, or flat power → use calculate_clipping.
4. If the question mentions utilization, loading, operating near rated → use calculate_inverter_utilization.
5. If the question mentions underperforming, anomaly, outlier → use detect_anomalies.
6. If the question mentions IQ9N vs IQ8HC or compares two models → use compare_energy or compare_telemetry.
7. If the question asks to "analyze", "deep dive", "investigate", or "tell me everything about" a specific site → use analyze_site. This runs a comprehensive multi-step workflow: fleet metadata, telemetry check, energy production, anomaly detection, and clipping analysis.
7b. If the question asks to analyze a specific microinverter serial number, "inverter 123456789012", "analyze microinverter 123456789012", or mentions a 12-digit serial → use analyze_microinverter. Put the serial number in the serials field.
8a. If the question asks for "nearby sites", "similar sites", "comparable sites", "peer sites", or "find sites near" a specific site ID → use find_nearby_sites. Optionally capture a microinverter model (IQ9N, IQ8HC etc.) in the products field.
8b. If the question is a GENERIC or EDUCATIONAL question that does NOT require querying fleet or telemetry data — such as "what is clipping?", "what is current clipping?", "explain DC/AC ratio", "what is the typical irradiance of France?", "how do microinverters work?", "what causes shading losses?", "tell me about IQ8HC specifications" — set intent to "knowledge", tool to "knowledge_answer", and unanswerable to false. The key distinction: if the user is asking about a CONCEPT, DEFINITION, or GENERAL FACT (even if it uses solar terms like clipping, irradiance, voltage), it is knowledge. If they reference a SPECIFIC SITE, SERIAL NUMBER, REGION CODE, or ask to QUERY/COMPARE/ANALYZE actual dashboard data, it is a data question.
8c. If the question cannot be answered from fleet or telemetry data AND is not a knowledge question (e.g. revenue, pricing, stock price) → set intent to "unanswerable" and unanswerable to true.
8d. If the question asks to find/list/show/give sites matching specific criteria such as microinverter model (IQ8HC, IQ9N, etc.), module power (420W, 450-500W), country (France, Germany, USA), state, irradiance level (very_high >5.5, high >4.5, medium 3.5–4.5, low <3.5 kWh/m²/day), or module type/wafer (monocrystalline, polycrystalline, G12R, G12, M10, M10R, M6, M12) → use fleet_search. Put filters in the filters object: { microinverter, minPowerW, maxPowerW, country, state, irradiance (very_high/high/medium/low), moduleWafer, moduleMake }. Put topN count in the limit field.
9. Set confidence to "high" when the intent is clear, "medium" when there are two reasonable interpretations, "low" when the question is ambiguous.
10. For product names: IQ9N, IQ8HC, IQ8P, IQ8H, IQ8M, IQ7A etc. are microinverter SKU families.
11. For regions: NA=North America, EURO=Europe, BR=Brazil, ANZP=Australia/NZ, LATAM=Latin America, IN=India, EMKT=Emerging Market.
12. Microinverter level analysis: if the user asks "by microinverter" or "by serial" → groupBy: ["serial_number"].

FEW-SHOT EXAMPLES:

Q: "Which TSS region had the most IQ9N units in Q1 2026?"
A: {"intent":"fleet_summary","tool":"get_fleet_summary","metric":"unit_count","aggregation":"sum","groupBy":["tss_region"],"filters":{"quarters":["2026 - Q1"],"skuNames":["IQ9N"]},"visualization":"bar","confidence":"high"}

Q: "Compare average DC/AC ratio between IQ8HC and IQ9N by region"
A: {"intent":"dc_ac_ratio","tool":"get_dc_ac_ratio","groupBy":["tss_region","product_type"],"filters":{"skuNames":["IQ8HC","IQ9N"]},"visualization":"bar","confidence":"high"}

Q: "What is the total energy produced by site S001 this year?"
A: {"intent":"energy_total","tool":"calculate_energy","metric":"energy_produced","groupBy":["site_id"],"filters":{"siteIds":["S001"]},"unit":"kWh","visualization":"kpi","confidence":"high"}

Q: "Show daily energy trend for site S005 in June 2025"
A: {"intent":"time_series","tool":"get_time_series","metric":"energy_produced","groupBy":"site_id","filters":{"siteIds":["S005"],"from":"2025-06-01","to":"2025-06-30"},"visualization":"line","confidence":"high"}

Q: "Which inverters at site S002 are underperforming?"
A: {"intent":"anomaly_detect","tool":"detect_anomalies","sites":["S002"],"visualization":"table","confidence":"high"}

Q: "How much clipping is happening at sites S001 and S003?"
A: {"intent":"clipping","tool":"calculate_clipping","sites":["S001","S003"],"visualization":"bar","confidence":"high"}

Q: "Compare IQ9N vs IQ8HC energy production"
A: {"intent":"energy_compare","tool":"compare_energy","products":["IQ9N","IQ8HC"],"visualization":"bar","confidence":"high"}

Q: "What is the average inverter utilization for IQ9N?"
A: {"intent":"inverter_utilization","tool":"calculate_inverter_utilization","filters":{"skuNames":["IQ9N"]},"groupBy":["sku_name"],"visualization":"bar","confidence":"high"}

Q: "Tell me about inverter 123456789012"
A: {"intent":"inverter_drilldown","tool":"get_inverter_drilldown","serials":["123456789012"],"visualization":"kpi","confidence":"high"}

Q: "Analyze site 12345"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["12345"],"visualization":"table","confidence":"high"}

Q: "Deep dive site S001, check everything"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["S001"],"visualization":"table","confidence":"high"}

Q: "Analyze microinverter 123456789012"
A: {"intent":"microinverter_analysis","tool":"analyze_microinverter","serials":["123456789012"],"visualization":"table","confidence":"high"}

Q: "How is inverter 123456789012 performing?"
A: {"intent":"microinverter_analysis","tool":"analyze_microinverter","serials":["123456789012"],"visualization":"table","confidence":"high"}

Q: "Why is site 99887 underperforming?"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["99887"],"visualization":"table","confidence":"high"}

Q: "Investigate site XYZ"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["XYZ"],"visualization":"table","confidence":"high"}

Q: "Check site 55443"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["55443"],"visualization":"table","confidence":"high"}

Q: "What's wrong with site 12345?"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["12345"],"visualization":"table","confidence":"high"}

Q: "Tell me everything about site 67890"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["67890"],"visualization":"table","confidence":"high"}

Q: "Run a full analysis on site ABC123"
A: {"intent":"site_analysis","tool":"analyze_site","sites":["ABC123"],"visualization":"table","confidence":"high"}

Q: "Find nearby sites of 5637519"
A: {"intent":"nearby_sites","tool":"find_nearby_sites","sites":["5637519"],"confidence":"high"}

Q: "Show me comparable sites near 5637519 with IQ9N microinverter"
A: {"intent":"nearby_sites","tool":"find_nearby_sites","sites":["5637519"],"products":["IQ9N"],"confidence":"high"}

Q: "What sites are similar to site 5637519?"
A: {"intent":"nearby_sites","tool":"find_nearby_sites","sites":["5637519"],"confidence":"high"}

Q: "Find peer sites for 5637519 within 100 km"
A: {"intent":"nearby_sites","tool":"find_nearby_sites","sites":["5637519"],"limit":100,"confidence":"high"}

Q: "Provide nearby sites of 12345 with IQ8HC"
A: {"intent":"nearby_sites","tool":"find_nearby_sites","sites":["12345"],"products":["IQ8HC"],"confidence":"high"}

Q: "Give me 10 sites that has IQ8HC with 420W module in France with high irradiance"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"microinverter":"IQ8HC","minPowerW":410,"maxPowerW":430,"country":"France","irradiance":"high"},"limit":10,"confidence":"high"}

Q: "Show me 20 sites with IQ8P and 450-500W modules in Germany"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"microinverter":"IQ8P","minPowerW":450,"maxPowerW":500,"country":"Germany"},"limit":20,"confidence":"high"}

Q: "Find sites in California with monocrystalline 400W+ modules"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"state":"California","moduleWafer":"monocrystalline","minPowerW":400},"confidence":"high"}

Q: "List 15 sites with IQ9N in Australia with high irradiance"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"microinverter":"IQ9N","country":"Australia","irradiance":"high"},"limit":15,"confidence":"high"}

Q: "Show sites in France with any inverter and 380-400W modules"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"minPowerW":380,"maxPowerW":400,"country":"France"},"confidence":"high"}

Q: "Find 30 sites with IQ7A in United States with very high irradiance"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"microinverter":"IQ7A","country":"United States","irradiance":"very_high"},"limit":30,"confidence":"high"}

Q: "Give me 10 sites with IQ8HC and G12R wafer with 420W modules in France with high irradiance"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"microinverter":"IQ8HC","moduleWafer":"G12R","minPowerW":410,"maxPowerW":430,"country":"France","irradiance":"high"},"limit":10,"confidence":"high"}

Q: "Show sites with M10 wafer and IQ9N in Germany"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"moduleWafer":"M10","microinverter":"IQ9N","country":"Germany"},"confidence":"high"}

Q: "Find 25 sites with IQ8P and G12 wafer 450-500W in Australia"
A: {"intent":"fleet_search","tool":"fleet_search","filters":{"microinverter":"IQ8P","moduleWafer":"G12","minPowerW":450,"maxPowerW":500,"country":"Australia"},"limit":25,"confidence":"high"}

Q: "What is clipping?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What is current clipping?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What is the irradiance of France?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "How do microinverters work?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "Explain DC/AC ratio"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What causes shading losses in solar panels?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What is the difference between string inverters and microinverters?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What is MPPT?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What are the specs of IQ8HC?"
A: {"intent":"knowledge","tool":"knowledge_answer","confidence":"high","unanswerable":false}

Q: "What will the revenue be next quarter?"
A: {"intent":"unanswerable","tool":"","unanswerable":true,"confidence":"high","caveat":"Revenue and financial forecasts are not available in fleet or telemetry data."}
`
}

// ─── Intent detection ─────────────────────────────────────────────────────────

export interface ConversationTurnContext {
  question: string
  /** Short summary of the assistant answer (not raw rows) */
  answerSummary: string
}

export interface IntentRouterOptions {
  contextTable?: 'fleet' | 'telemetry' | 'both'
  retryOnParseError?: boolean
  /** Up to 3 most recent conversation turns for follow-up resolution */
  conversationContext?: ConversationTurnContext[]
}

export class IntentParseError extends Error {
  readonly rawResponse: string
  constructor(message: string, rawResponse: string) {
    super(message)
    this.name = 'IntentParseError'
    this.rawResponse = rawResponse
  }
}

// Metric aliases Gemini (and other LLMs) commonly return instead of the exact column names
// Separated by domain so fleet aliases (dc_power → stc_mwdc) don't clobber telemetry (dc_power is valid).

const FLEET_METRIC_ALIAS: Record<string, string> = {
  site_count: 'unit_count',
  sites: 'unit_count',
  count: 'unit_count',
  num_sites: 'unit_count',
  total_sites: 'unit_count',
  units: 'unit_count',
  total_units: 'unit_count',
  num_units: 'unit_count',
  number_of_units: 'unit_count',
  number_of_sites: 'unit_count',
  inverters: 'unit_count',
  microinverters: 'unit_count',
  num_inverters: 'unit_count',
  power: 'stc_mwdc',
  capacity: 'stc_mwdc',
  dc_power: 'stc_mwdc',
  dc_capacity: 'stc_mwdc',
  stc_power: 'stc_mwdc',
  mw_dc: 'stc_mwdc',
  mw: 'stc_mwdc',
  ac_power: 'mwac',
  ac_capacity: 'mwac',
  mw_ac: 'mwac',
  'dc/ac_ratio': 'dc_ac_ratio',
  'dc/ac': 'dc_ac_ratio',
  dcac_ratio: 'dc_ac_ratio',
  dcac: 'dc_ac_ratio',
  ratio: 'dc_ac_ratio',
  irradiance: 'irr_ann_kwh_m2_month',
  solar_irradiance: 'irr_ann_kwh_m2_month',
  annual_irradiance: 'irr_ann_kwh_m2_month',
  irr: 'irr_ann_kwh_m2_month',
  ghi: 'irr_ann_kwh_m2_month',
  rating: 'stc_rating2',
  stc_rating: 'stc_rating2',
  panel_rating: 'stc_rating2',
  module_rating: 'stc_rating2',
  open_circuit_voltage: 'voc',
  voltage: 'voc',
  short_circuit_current: 'isc',
  current: 'isc',
}

const TELEMETRY_METRIC_ALIAS: Record<string, string> = {
  // dc_voltage aliases
  voltage: 'dc_voltage',
  vmp: 'dc_voltage',
  v_mp: 'dc_voltage',
  vdc: 'dc_voltage',
  panel_voltage: 'dc_voltage',
  module_voltage: 'dc_voltage',
  string_voltage: 'dc_voltage',
  mppt_voltage: 'dc_voltage',
  // dc_current aliases
  current: 'dc_current',
  imp: 'dc_current',
  i_mp: 'dc_current',
  idc: 'dc_current',
  panel_current: 'dc_current',
  // dc_power aliases
  power: 'dc_power',
  dc: 'dc_power',
  watt: 'dc_power',
  watts: 'dc_power',
  // ac_power aliases
  ac: 'ac_power',
  ac_watt: 'ac_power',
  output_power: 'ac_power',
  // ac_voltage aliases
  vac: 'ac_voltage',
  grid_voltage: 'ac_voltage',
  line_voltage: 'ac_voltage',
  // ac_frequency aliases
  frequency: 'ac_frequency',
  freq: 'ac_frequency',
  hz: 'ac_frequency',
  grid_frequency: 'ac_frequency',
  // temperature aliases
  temperature: 'temperature_c',
  temp: 'temperature_c',
  temp_c: 'temperature_c',
  celsius: 'temperature_c',
  temp_f: 'temperature_f',
  fahrenheit: 'temperature_f',
  // energy aliases
  energy: 'energy_produced',
  production: 'energy_produced',
  yield: 'energy_produced',
  kwh: 'energy_produced',
  wh: 'energy_produced',
}

const VALID_FLEET_METRICS = new Set([
  'unit_count', 'stc_mwdc', 'mwac', 'dc_ac_ratio',
  'stc_rating2', 'irr_ann_kwh_m2_month', 'voc', 'isc',
])

const VALID_TELEMETRY_METRICS = new Set([
  'energy_produced', 'dc_power', 'ac_power', 'temperature_c', 'temperature_f',
  'dc_current', 'dc_voltage', 'ac_voltage', 'ac_frequency', 'duration',
])

const TELEMETRY_TOOLS = new Set([
  'get_telemetry_statistics', 'get_time_series', 'compare_telemetry',
  'calculate_clipping', 'calculate_energy', 'compare_energy',
  'calculate_energy_per_inverter', 'detect_anomalies',
])

/** Fix common LLM mistakes in the parsed JSON before Zod validation. */
function normalizeAnalysisRequest(parsed: Record<string, unknown>): void {
  // Fix invalid metric values — pick alias map based on tool context
  if (typeof parsed['metric'] === 'string') {
    const raw = parsed['metric'].toLowerCase().trim()
    const tool = typeof parsed['tool'] === 'string' ? parsed['tool'] : ''
    const isTelemetry = TELEMETRY_TOOLS.has(tool)

    if (isTelemetry) {
      if (VALID_TELEMETRY_METRICS.has(raw)) {
        parsed['metric'] = raw
      } else {
        const alias = TELEMETRY_METRIC_ALIAS[raw]
        if (alias) {
          parsed['metric'] = alias
        } else {
          console.warn(`[intentRouter] Unrecognized telemetry metric "${parsed['metric']}", defaulting to dc_voltage`)
          parsed['metric'] = 'dc_voltage'
        }
      }
    } else {
      if (VALID_FLEET_METRICS.has(raw)) {
        parsed['metric'] = raw
      } else {
        const alias = FLEET_METRIC_ALIAS[raw]
        if (alias) {
          parsed['metric'] = alias
        } else {
          console.warn(`[intentRouter] Unrecognized fleet metric "${parsed['metric']}", defaulting to unit_count`)
          parsed['metric'] = 'unit_count'
        }
      }
    }
  }

  // Ensure unanswerable defaults to false if not present
  if (parsed['unanswerable'] === undefined) {
    parsed['unanswerable'] = false
  }

  // If tool is missing but intent is present, try to infer tool name
  if (!parsed['tool'] && typeof parsed['intent'] === 'string') {
    const INTENT_TOOL_MAP: Record<string, string> = {
      fleet_summary: 'get_fleet_summary',
      site_summary: 'get_fleet_summary',
      product_summary: 'get_fleet_summary',
      region_summary: 'get_region_summary',
      clipping: 'calculate_clipping',
      inverter_utilization: 'calculate_inverter_utilization',
      anomaly_detect: 'detect_anomalies',
      site_analysis: 'analyze_site',
      microinverter_analysis: 'analyze_microinverter',
      nearby_sites: 'find_nearby_sites',
      fleet_search: 'fleet_search',
      energy_total: 'calculate_energy',
      energy_compare: 'compare_energy',
      dc_ac_ratio: 'get_dc_ac_ratio',
      time_series: 'get_time_series',
      knowledge: 'knowledge_answer',
    }
    const tool = INTENT_TOOL_MAP[parsed['intent'] as string]
    if (tool) parsed['tool'] = tool
  }
}

/** Strips Markdown code fences and leading/trailing whitespace from LLM output. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  // Find first '{' and last '}'
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

/**
 * Stage 1 — calls the LLM Analyst to convert a natural language question into
 * a validated AnalysisRequest. Retries once with the parse error appended if
 * the first response is not valid JSON or fails schema validation.
 */
/** Fast regex pre-check — returns immediately for unambiguous site analysis queries without calling the LLM. */
function tryFastSiteAnalysis(question: string): AnalysisRequest | null {
  const q = question.trim().toLowerCase()
  // Patterns: "analyze site 123", "analyse site 123", "deep dive 123", "investigate site 123",
  //           "tell me everything about site 123", "run full analysis on 123", "what's wrong with site 123"
  const patterns = [
    /(?:analyze|analyse|analysis|deep.?dive|investigate|diagnose|review|inspect|check|examine)\s+(?:site\s+)?(\d{5,})/i,
    /(?:what(?:'s|\s+is)\s+wrong\s+with\s+site\s+|tell\s+me\s+everything\s+about\s+site\s+|run\s+(?:full\s+)?analysis\s+(?:on\s+|for\s+)?(?:site\s+)?)(\d{5,})/i,
    /site\s+(\d{5,})\s+(?:analysis|performance|report|deep.?dive|summary)/i,
  ]
  for (const pattern of patterns) {
    const match = q.match(pattern)
    if (match) {
      const siteId = match[1] ?? match[2] ?? ''
      if (siteId) {
        return {
          intent: 'site_analysis',
          tool: 'analyze_site',
          sites: [siteId],
          confidence: 'high',
          unanswerable: false,
        }
      }
    }
  }
  return null
}

/** Returns true if the question explicitly opts out of module data filtering. */
function userWantsNoModuleFilter(q: string): boolean {
  return /module\s*(?:data|info(?:rmation)?)?\s*(?:doesn?'?t?\s+matter|not\s+important|not\s+required|isn'?t?\s+important|ignore|without)|ignore\s+module|no\s+module\s+filter/i.test(q)
}

/** Fast regex pre-check for obvious "nearby/similar/peer sites" queries — no LLM call. */
function tryFastNearbySites(question: string): AnalysisRequest | null {
  const q = question.trim()

  // Capture optional IQ-family microinverter model anywhere in the string
  const microMatch = q.match(/\b(IQ\d+[A-Z0-9]*(?:-[A-Z0-9]+)*)\b/i)
  const microinverter = microMatch ? microMatch[1].toUpperCase() : undefined

  // Detect opt-out of module filter
  const requireModuleInfo = userWantsNoModuleFilter(q) ? false : undefined

  const patterns = [
    // "nearby/similar/comparable/peer sites of/for/near/to (site) 12345"
    /(?:nearby|near|similar|comparable|peer)\s+sites?\s+(?:of|for|to|near)?\s*(?:site\s+)?(\d{5,})/i,
    // "find nearby/similar/comparable sites for/near/to (site) 12345"
    /find\s+(?:nearby|similar|comparable|peer)\s+(?:sites?\s+)?(?:for|to|near|of)?\s*(?:site\s+)?(\d{5,})/i,
    // "sites near site 12345" / "sites similar to site 12345"
    /sites?\s+(?:near|similar\s+to|close\s+to|like)\s+(?:site\s+)?(\d{5,})/i,
    // "provide nearby sites of 12345"
    /provide\s+(?:nearby|similar|comparable|peer)\s+sites?\s+(?:of|for|near)?\s*(?:site\s+)?(\d{5,})/i,
    // "show me sites near 12345"
    /show\s+(?:me\s+)?(?:nearby|similar|comparable|peer)\s+sites?\s+(?:of|for|near|to)?\s*(?:site\s+)?(\d{5,})/i,
  ]

  for (const pattern of patterns) {
    const match = q.match(pattern)
    if (match) {
      const siteId = match[1] ?? ''
      if (siteId) {
        return {
          intent: 'nearby_sites',
          tool: 'find_nearby_sites',
          sites: [siteId],
          products: microinverter ? [microinverter] : undefined,
          confidence: 'high',
          unanswerable: false,
          ...(requireModuleInfo === false ? { requireModuleInfo } : {}),
        }
      }
    }
  }
  return null
}

/** Fast regex pre-check for fleet-roster search queries — extracts micro/power/country/irradiance filters. */
function tryFastFleetSearch(question: string): AnalysisRequest | null {
  const q = question.trim()

  // Must look like a search-for-sites request
  if (!/(?:give|show|find|list|get|provide)\s+(?:me\s+)?(?:\d+\s+)?sites?/i.test(q)) return null

  // Must carry at least one filterable criterion (micro, power, country, irradiance, wafer)
  const hasMicro   = /\bIQ\d/i.test(q)
  const hasPower   = /\d{3,4}\s*[Ww](?:att)?/.test(q)
  const hasCountry = /\b(?:France|Germany|United\s+States|USA|Australia|Brazil|India|Italy|Spain|Netherlands|Belgium|Japan|Canada|Mexico|UK|Portugal)\b/i.test(q)
  const hasIrr     = /irradiance/i.test(q)
  const hasWafer   = /\b(?:G12R|G12|M10R|M10|M12|M6|mono(?:crystalline)?|poly(?:crystalline)?)\b/i.test(q)
  if (!hasMicro && !hasPower && !hasCountry && !hasIrr && !hasWafer) return null

  const filters: Record<string, unknown> = {}

  // topN: "give me 10 sites" / "20 sites"
  const countMatch = q.match(/(?:give|show|find|list|get|provide)\s+(?:me\s+)?(\d+)\s+sites?|(\d+)\s+sites?/i)
  const topN = countMatch ? parseInt(countMatch[1] ?? countMatch[2] ?? '10') : undefined

  // Microinverter model
  const microMatch = q.match(/\b(IQ\d+[A-Z0-9]*(?:[+\-][A-Z0-9]+)*)\b/i)
  if (microMatch) filters.microinverter = microMatch[1].toUpperCase()

  // Power range: "450-500W" or "450–500W" or "450 to 500W"
  const rangeMatch = q.match(/(\d{3,4})\s*[-–—to]+\s*(\d{3,4})\s*[Ww]/i)
  if (rangeMatch) {
    filters.minPowerW = parseInt(rangeMatch[1])
    filters.maxPowerW = parseInt(rangeMatch[2])
  } else {
    // Single power: "420W" — allow ±10 W tolerance
    const singleMatch = q.match(/(\d{3,4})\s*[Ww](?:att)?(?!\d)/i)
    if (singleMatch) {
      const pw = parseInt(singleMatch[1])
      filters.minPowerW = pw - 10
      filters.maxPowerW = pw + 10
    } else if (/(\d{3,4})W\+/.test(q)) {
      // "400W+" → min only
      const plusMatch = q.match(/(\d{3,4})[Ww]\+/)
      if (plusMatch) filters.minPowerW = parseInt(plusMatch[1])
    }
  }

  // Country (map common aliases)
  const COUNTRY_MAP: Record<string, string> = {
    usa: 'United States', 'united states': 'United States',
    uk: 'United Kingdom', france: 'France', germany: 'Germany',
    australia: 'Australia', brazil: 'Brazil', india: 'India',
    italy: 'Italy', spain: 'Spain', netherlands: 'Netherlands',
    belgium: 'Belgium', japan: 'Japan', canada: 'Canada',
    mexico: 'Mexico', portugal: 'Portugal',
  }
  for (const [alias, canonical] of Object.entries(COUNTRY_MAP)) {
    if (new RegExp(`\\b${alias}\\b`, 'i').test(q)) { filters.country = canonical; break }
  }

  // Irradiance level
  if (/very\s+high\s+irradiance|highest?\s+irradiance/i.test(q))     filters.irradiance = 'very_high'
  else if (/high\s+irradiance/i.test(q))                              filters.irradiance = 'high'
  else if (/medium\s+irradiance|moderate\s+irradiance/i.test(q))     filters.irradiance = 'medium'
  else if (/low\s+irradiance/i.test(q))                              filters.irradiance = 'low'

  // State / province (US-focused list)
  const US_STATES = ['California','Texas','Florida','New York','Arizona','Nevada','Colorado',
    'New Mexico','Hawaii','New Jersey','Massachusetts','Ohio','Georgia','North Carolina']
  for (const st of US_STATES) {
    if (new RegExp(`\\b${st}\\b`, 'i').test(q)) { filters.state = st; break }
  }

  // Module wafer / silicon wafer format code — check specifics first to avoid partial matches
  // Order matters: G12R before G12, M10R before M10
  const WAFER_CODES: [RegExp, string][] = [
    [/\bG12R\b/i,             'G12R'],
    [/\bM10R\b/i,             'M10R'],
    [/\bG12\b/i,              'G12'],
    [/\bM10\b/i,              'M10'],
    [/\bM12\b/i,              'M12'],
    [/\bM6\b/i,               'M6'],
    [/monocrystalline|mono[-\s]?Si/i,  'monocrystalline'],
    [/polycrystalline|poly[-\s]?Si/i,  'polycrystalline'],
  ]
  for (const [pat, val] of WAFER_CODES) {
    if (pat.test(q)) { filters.moduleWafer = val; break }
  }

  return {
    intent: 'fleet_search',
    tool: 'fleet_search',
    filters,
    ...(topN ? { limit: topN } : {}),
    confidence: 'high',
    unanswerable: false,
  }
}

export async function detectIntent(
  question: string,
  provider: LLMProvider,
  options: IntentRouterOptions = {}
): Promise<AnalysisRequest> {
  const { contextTable = 'both', retryOnParseError = true, conversationContext } = options

  // Fast path: skip LLM for obvious site analysis requests
  const fast = tryFastSiteAnalysis(question)
  if (fast) return fast

  // Fast path: skip LLM for obvious nearby/similar sites requests
  const fastNearby = tryFastNearbySites(question)
  if (fastNearby) return fastNearby

  // Fast path: skip LLM for obvious fleet search requests
  const fastFleet = tryFastFleetSearch(question)
  if (fastFleet) return fastFleet

  const systemPrompt = buildSystemPrompt(contextTable)

  const contextPrefix = conversationContext && conversationContext.length > 0
    ? `[CONVERSATION CONTEXT — last ${conversationContext.length} turn(s)]\n` +
      conversationContext
        .slice(-3)
        .map((t) => `User: ${t.question}\nAssistant: ${t.answerSummary}`)
        .join('\n---\n') +
      '\n[END CONTEXT]\n\n'
    : ''

  async function attemptDetection(userPrompt: string): Promise<AnalysisRequest> {
    const result = await provider.complete(userPrompt, systemPrompt, {
      temperature: 0,
      maxTokens: 512,
      timeoutMs: 20_000,
      jsonMode: true,
      disableThinking: true,
    })

    const jsonStr = extractJson(result.text)
    console.debug('[intentRouter] LLM raw text:', result.text.slice(0, 400))
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      throw new IntentParseError(
        `LLM response was not valid JSON: ${jsonStr.slice(0, 200)}`,
        result.text
      )
    }

    // Normalize common LLM mistakes before validation
    normalizeAnalysisRequest(parsed)

    const validated = AnalysisRequestSchema.safeParse(parsed)
    if (!validated.success) {
      console.debug('[intentRouter] Zod validation failed:', validated.error.message, 'parsed:', JSON.stringify(parsed).slice(0, 300))
      throw new IntentParseError(
        `AnalysisRequest schema validation failed: ${validated.error.message}`,
        result.text
      )
    }
    return validated.data
  }

  try {
    return await attemptDetection(contextPrefix + question)
  } catch (err) {
    // On LLM timeout or unavailability, fall back to heuristic fast paths before giving up
    const isLLMFailure = err instanceof Error &&
      (err.message.includes('timed out') || err.message.includes('unavailable') ||
       err.message.includes('timeout'))
    if (isLLMFailure) {
      const fallbackFleet = tryFastFleetSearch(question)
      if (fallbackFleet) return fallbackFleet
      const fallbackSite = tryFastSiteAnalysis(question)
      if (fallbackSite) return fallbackSite
      const fallbackNearby = tryFastNearbySites(question)
      if (fallbackNearby) return fallbackNearby
      return {
        intent: 'unanswerable',
        tool: '',
        unanswerable: true,
        confidence: 'low',
        caveat: `LLM provider is not responding. Please check your settings and try again.`,
      }
    }

    if (!retryOnParseError || !(err instanceof IntentParseError)) throw err

    // Retry once with error context appended
    const retryPrompt = `${question}\n\n[SYSTEM NOTE: Your previous response failed to parse. Error: ${err.message}. Please output ONLY valid JSON matching the schema.]`
    try {
      return await attemptDetection(retryPrompt)
    } catch {
      // Both attempts failed — try heuristic fallback then give up
      const fallbackFleet = tryFastFleetSearch(question)
      if (fallbackFleet) return fallbackFleet
      return {
        intent: 'unanswerable',
        tool: '',
        unanswerable: true,
        confidence: 'low',
        caveat: 'Could not determine intent from the question. Please try rephrasing.',
      }
    }
  }
}
