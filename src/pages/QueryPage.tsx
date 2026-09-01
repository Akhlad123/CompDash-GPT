import { useState, useCallback, useEffect, useMemo, useRef } from 'react'

import {
  Loader2, Search, ChevronDown, ChevronRight, AlertTriangle, Sparkles,
  ExternalLink, MessageCircleQuestion, Clock, Info, HelpCircle, Database,
  BarChart3,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import ReactECharts from 'echarts-for-react'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useFleetStore } from '@/store/fleetStore'
import { query } from '@/lib/duckdb'
import {
  loadEntityDictionaries, parseFleetQuestion, type EntityDictionaries, type ParsedQuery,
} from '@/lib/nlQueryParser'
import {
  fetchLLMFallback, fetchInsight, retryWithError, fetchEmptyResultExplanation,
  warmupOllama,
  type DataStats, type ConversationTurn,
} from '@/lib/nlQueryLLM'
import { detectIntent } from '@/lib/intentRouter'
import type { ConversationTurnContext } from '@/lib/intentRouter'
import { dispatchTool, ToolNotFoundError, ToolParamError } from '@/lib/toolDispatcher'
import { explainResultStream, buildFallbackSummary } from '@/lib/explainer'
import { getOllamaProvider, currentProviderModel, currentProviderLabel, warmupProvider } from '@/lib/llmProvider'
import type { AnalysisRequest } from '@/lib/intentRouter'
import { validateFleetSql, fixSqlGroupBy } from '@/lib/sqlSafety'
import { routeQuestion, type QueryTarget } from '@/lib/nlQueryRouter'
import { loadTelemetryDictionaries, parseTelemetryQuestion, type TelemetryDictionaries } from '@/lib/nlQueryParserTelemetry'
import { useDataStore } from '@/store/dataStore'
import { useAskApiQuestion } from '@/features/ask-question/hooks/useAskApiQuestion'
import { SiteAnalysisResult, MicroinverterAnalysisResult, NearbyResultRenderer, FleetSearchResult } from '@/components/SiteAnalysisResult'
import OllamaSettingsDialog from '@/components/OllamaSettingsDialog'
import { ArtifactRenderer } from '@/features/ask-question/components/ArtifactRenderer'
import { EvidencePanel } from '@/features/ask-question/components/EvidencePanel'

const USE_NEW_ENGINE = true

/** Lightweight markdown → HTML for LLM insight text. Handles bold, italic, headers, bullets, code, and line breaks. */
function renderMarkdown(md: string): string {
  return md
    // Escape HTML entities
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Headers: ### H3, ## H2, # H1
    .replace(/^### (.+)$/gm, '<h4 class="font-semibold text-sm mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>')
    .replace(/^# (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    // Bold + italic: ***text***
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic: *text*
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code: `code`
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs">$1</code>')
    // Bullet lists: - item or * item
    .replace(/^[\-\*] (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    // Numbered lists: 1. item
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="my-1 space-y-0.5">$1</ul>')
    // Paragraphs: double newlines
    .replace(/\n\n/g, '</p><p class="mt-2">')
    // Single newlines (within a paragraph)
    .replace(/\n/g, '<br/>')
}

const COLUMN_LABELS: Record<string, string> = {
  irr_ann_kwh_m2_month: 'Irradiance (kWh/m\u00b2/day)',
  stc_rating2: 'STC Rating (W)',
  stc_mwdc: 'STC MWdc',
  mwac: 'MWac',
  dc_ac_ratio: 'DC/AC Ratio',
  avg_dc_ac_ratio: 'Avg DC/AC Ratio',
  min_dc_ac_ratio: 'Min DC/AC Ratio',
  max_dc_ac_ratio: 'Max DC/AC Ratio',
  median_dc_ac_ratio: 'Median DC/AC Ratio',
  unit_count: 'Unit Count',
  total_units: 'Total Units',
  site_count: 'Site Count',
  sites: 'Sites',
  result: 'Result',
  region_bundle: 'Region',
  tss_region: 'TSS Region',
  tss_country: 'TSS Country',
  quarter_first_interval: 'Quarter (First)',
  quarter_device_created: 'Quarter (Created)',
  pv_module_make: 'Module Make',
  module_wafer: 'Module Wafer',
  power_bucket: 'Power Bucket',
  power_block: 'Power Block',
  site_id: 'Site ID',
  zip_code: 'Zip Code',
}

const prettyCol = (c: string) => COLUMN_LABELS[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())

const EXAMPLE_CATEGORIES = [
  {
    label: 'Counts & Units',
    questions: [
      'How many sites in Germany',
      'Total units in North America',
      'How many sites in Europe',
    ],
  },
  {
    label: 'DC/AC Ratio',
    questions: [
      'DC AC ratio of North America',
      'Average DC/AC ratio in Europe',
      'DC/AC ratio distribution by region',
      'Top 10 sites with lowest DC/AC ratio',
    ],
  },
  {
    label: 'Irradiance & Ratings',
    questions: [
      'Top 10 sites with highest irradiance in France which pair with IQ8P and module is G12R',
      'Average STC rating in Australia and New Zealand',
      'Average irradiance in Brazil',
    ],
  },
  {
    label: 'Rankings',
    questions: [
      'Top 5 sites with most units in India',
      'Top 10 sites with highest STC rating',
    ],
  },
  {
    label: 'System Expansion (Lotto)',
    questions: [
      'How many sites have been expanded globally',
      'Show system expansion details',
      'System expansion trend by region',
    ],
  },
]

const TELEMETRY_EXAMPLE_CATEGORIES = [
  {
    label: 'Energy & Performance',
    questions: [
      'Total energy produced across all sites',
      'Daily energy trend',
      'Which inverter produced the most energy',
      'Peak power hours',
    ],
  },
  {
    label: 'Voltage & Current',
    questions: [
      'Inverters not crossing Vmp 40V',
      'Average DC voltage by inverter',
      'AC voltage drop analysis',
      'Average DC current per inverter',
    ],
  },
  {
    label: 'Anomalies & Diagnostics',
    questions: [
      'Underperforming inverters z-score',
      'Clipping events detected',
      'Hottest inverters by temperature',
      'Night-time energy leakage check',
    ],
  },
]

function safe(n: unknown): string {
  if (n === null || n === undefined) return '\u2014'
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(n)
}

// ID/string columns that must NEVER be number-formatted (commas would corrupt them)
const RAW_STRING_COLS = new Set([
  'site_id', 'serial_number', 'sku_name', 'date', 'hour',
  'local_date', 'hour_of_day', 'timestamp', 'day', 'month',
])
function safeCell(n: unknown, col: string): string {
  if (n === null || n === undefined) return '\u2014'
  if (RAW_STRING_COLS.has(col)) return String(n)
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(n)
}

/** Extract desired row limit from natural language. */
export function extractLimit(question: string, def = 20): number {
  const lower = question.toLowerCase()
  if (/\ball\b|no\s*limit|everything/.test(lower)) return 1000
  const m = lower.match(/\b(?:top|show|give|limit|fetch|return|get)\s+(\d+)\b/)
    ?? lower.match(/\b(\d+)\s*(?:rows?|results?|records?|entries)\b/)
    ?? lower.match(/\b(?:first|last)\s+(\d+)\b/)
  if (m) return Math.min(parseInt(m[1], 10), 1000)
  return def
}

function isMoreRowsRequest(q: string): boolean {
  return /\bmore\s*rows?\b|\bmore\s*results?\b|\bshow\s*more\b|\bmore\s*data\b|\bincrease\s*(the\s*)?(limit|rows?)\b|\bgive\s*(me\s*)?more\b|\bshow\s*all\b/.test(q.toLowerCase())
    || /\b(\d+)\s*(?:rows?|results?|records?)\b/.test(q.toLowerCase())
}

function replaceLimitInSql(sql: string, newLimit: number): string {
  return /\bLIMIT\s+\d+/i.test(sql)
    ? sql.replace(/\bLIMIT\s+\d+/gi, `LIMIT ${newLimit}`)
    : `${sql} LIMIT ${newLimit}`
}

export default function QueryPage() {
  const { isLoading: fleetLoading, error: fleetError } = useEnsureFleetData()
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)

  const [question, setQuestion] = useState('')
  const [dictionaries, setDictionaries] = useState<EntityDictionaries | null>(null)
  const [telemetryDicts, setTelemetryDicts] = useState<TelemetryDictionaries | null>(null)
  const [queryTarget, setQueryTarget] = useState<QueryTarget>('fleet')
  const isTelemetryLoaded = useDataStore((s) => s.isDataLoaded)
  const [result, setResult] = useState<ParsedQuery | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [queryLoading, setQueryLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [showSql, setShowSql] = useState(false)
  const [insight, setInsight] = useState<string>('')
  const [insightLoading, setInsightLoading] = useState(false)
  const [emptyResultExplanation, setEmptyResultExplanation] = useState<string | null>(null)
  const [showChart, setShowChart] = useState(false)
  const [isOfflineFallback, setIsOfflineFallback] = useState(false)
  const [analysisRequest, setAnalysisRequest] = useState<AnalysisRequest | null>(null)
  const apiQuestion = useAskApiQuestion()

  // Query result cache — avoid re-hitting Ollama for identical questions
  const queryCache = useRef<Map<string, { parsed: ParsedQuery; rows: Record<string, unknown>[]; ts: number }>>(new Map())
  const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

  // Warmup Ollama on mount so model is already loaded for the first query
  useEffect(() => {
    if (USE_NEW_ENGINE) warmupProvider(getOllamaProvider())
    else warmupOllama()
  }, [])

  // Clarification / follow-up state
  const [pendingParsed, setPendingParsed] = useState<ParsedQuery | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<string>('')
  const [showExamples, setShowExamples] = useState(true)

  // Site analysis conversation context — last 3 turns (question + brief answer summary)
  const [siteAnalysisContext, setSiteAnalysisContext] = useState<ConversationTurnContext[]>([])

  // Conversation history for context (follow-up questions)
  const [history, setHistory] = useState<Array<{
    question: string
    answer: string
    sql?: string
    resultSummary?: string
    timestamp: number
  }>>([])
  const conversationHistory: ConversationTurn[] = useMemo(
    () => history
      .filter((h) => h.sql)
      .map((h) => ({ question: h.question, sql: h.sql!, resultSummary: h.resultSummary }))
      .reverse()
      .slice(0, 5),
    [history]
  )

  useEffect(() => {
    if (isFleetLoaded && !dictionaries) {
      loadEntityDictionaries().then(setDictionaries)
    }
  }, [isFleetLoaded, dictionaries])

  useEffect(() => {
    if (isTelemetryLoaded && !telemetryDicts) {
      loadTelemetryDictionaries().then(setTelemetryDicts)
    }
  }, [isTelemetryLoaded, telemetryDicts])

  const availableQuarters = useMemo(
    () => dictionaries?.quarter_first_interval?.filter(Boolean).sort() ?? [],
    [dictionaries]
  )

  /** Execute parsed SQL, with 1-shot auto-retry on DuckDB error, then stream insight. */
  const executeParsed = useCallback(
    async (
      parsed: ParsedQuery,
      originalQuestion: string,
      dicts: Record<string, string[]>,
      target: QueryTarget,
    ) => {
      // Auto-fix GROUP BY mismatches before validation
      parsed = { ...parsed, sql: fixSqlGroupBy(parsed.sql) }
      setResult(parsed)
      setEmptyResultExplanation(null)
      const validation = validateFleetSql(parsed.sql)
      if (!validation.valid) {
        setQueryError(`Generated SQL failed validation: ${validation.reason}`)
        return
      }

      let data: Record<string, unknown>[]
      try {
        data = await query<Record<string, unknown>>(parsed.sql)
      } catch (execErr) {
        // ── Auto-retry: send DuckDB error back to Ollama once ──
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr)
        try {
          const retried = await retryWithError(originalQuestion, parsed.sql, errMsg, dicts, target)
          const retryValidation = validateFleetSql(retried.sql)
          if (!retryValidation.valid) throw new Error(`Retry SQL invalid: ${retryValidation.reason}`)
          data = await query<Record<string, unknown>>(retried.sql)
          setResult(retried)
          parsed = retried
        } catch (retryErr) {
          throw retryErr instanceof Error ? retryErr : new Error(String(retryErr))
        }
      }

      setRows(data)

      // Build result summary for conversation history
      let resultSummary = `→ ${data.length} row${data.length !== 1 ? 's' : ''}`
      if (data.length === 1) {
        const vals = Object.entries(data[0])
          .slice(0, 3)
          .map(([k, v]) => `${prettyCol(k)}: ${safe(v)}`)
          .join(', ')
        resultSummary = `→ ${vals}`
      } else if (data.length > 1) {
        const firstKey = Object.keys(data[0])[0]
        const firstVal = firstKey ? `top: ${safe(data[0][firstKey])}` : ''
        resultSummary = `→ ${data.length} rows${firstVal ? `, ${firstVal}` : ''}`
      }
      setHistory((h) => [{
        question: originalQuestion,
        answer: `${parsed.explanation} ${resultSummary}`,
        sql: parsed.sql,
        resultSummary,
        timestamp: Date.now(),
      }, ...h].slice(0, 20))

      // Stream insight progressively
      if (data.length > 0) {
        setInsight('')
        setInsightLoading(true)
        fetchInsight(
          originalQuestion, parsed.sql, data, target,
          (token) => setInsight((prev) => prev + token),
          () => setInsightLoading(false),
        )
      } else {
        // 0 rows — ask Ollama why
        fetchEmptyResultExplanation(originalQuestion, parsed.sql, dicts)
          .then((msg) => setEmptyResultExplanation(msg))
          .catch(() => null)
      }
    },
    []
  )

  /** New tool-driven engine path — gated by VITE_NEW_QUERY_ENGINE=true */
  const runWithNewEngine = useCallback(
    async (q: string) => {
      setQueryLoading(true)
      setQueryError(null)
      setRows(null)
      setInsight('')
      setEmptyResultExplanation(null)
      setIsOfflineFallback(false)
      setShowChart(false)
      setPendingParsed(null)
      setShowExamples(false)
      setAnalysisRequest(null)

      try {
        const contextTable = (isTelemetryLoaded && isFleetLoaded) ? 'both'
          : isTelemetryLoaded ? 'telemetry' : 'fleet'

        setInsight('Detecting intent…')
        const request = await detectIntent(q, getOllamaProvider(), {
          contextTable,
          conversationContext: siteAnalysisContext.length > 0 ? siteAnalysisContext : undefined,
        })
        setInsight('')
        setAnalysisRequest(request)

        // ── Knowledge question: stream a direct LLM answer ──
        if (request.intent === 'knowledge') {
          setInsightLoading(true)
          setResult({ sql: '', confidence: 'high', explanation: 'Direct LLM answer (knowledge question)', matchedEntities: {} })
          const provider = getOllamaProvider()
          const solarSystemPrompt = `You are a solar energy expert assistant in a microinverter fleet dashboard (CompDash GPT).

FORMATTING RULES:
- Start with a clear, direct answer in 1-2 sentences.
- Use bullet points (- ) for lists. Do NOT use nested bullets.
- Use **bold** only for key terms being defined, not for every phrase.
- Use ## for section headers only if the answer has 2+ distinct sections.
- Keep answers concise: 150-250 words maximum.
- Do NOT overuse bold or formatting — keep it clean and readable.
- If referencing numbers (irradiance, specs), note they are approximate/typical.

DOMAIN: solar energy, photovoltaics, Enphase microinverters (IQ7, IQ8, IQ9 series), clipping, irradiance, DC/AC ratio, module types.
For solar terms: explain what it is, why it matters, and its impact on system performance.`
          try {
            await provider.stream(q, solarSystemPrompt, (token) => {
              setInsight((prev) => prev + token)
            }, { temperature: 0.4, maxTokens: 600, timeoutMs: 30_000 })
          } catch {
            setInsight('Sorry, I could not generate an answer right now. Please try again.')
          } finally {
            setInsightLoading(false)
          }
          setHistory((h) => [{
            question: q,
            answer: 'knowledge',
            resultSummary: 'Direct LLM answer',
            timestamp: Date.now(),
          }, ...h].slice(0, 20))
          return
        }

        if (request.unanswerable) {
          setInsight(request.caveat ?? 'This question cannot be answered from available data.')
          setResult({ sql: '', confidence: 'low', explanation: '', matchedEntities: {} })
          return
        }

        if (request.intent === 'site_analysis') setInsight('Running site analysis workflow (fleet → peers → telemetry → clipping → benchmarking)…')
        if (request.intent === 'microinverter_analysis') setInsight('Running microinverter analysis workflow (telemetry → AC power → voltage/frequency/temperature → clipping)…')
        if (request.intent === 'nearby_sites') setInsight('Searching for comparable sites (v2 similarity: geography · power · microinverter · wafer · irradiance)…')
        if (request.intent === 'fleet_search') setInsight('Searching fleet roster…')
        const toolResult = await dispatchTool(request)
        setInsight('')
        setRows(toolResult.rows as Record<string, unknown>[])
        setResult({
          sql: toolResult.metadata.sql ?? `tool: ${toolResult.metadata.tool}`,
          confidence: request.confidence,
          explanation: `${toolResult.metadata.tool} → ${toolResult.metadata.rowCount} rows (${toolResult.metadata.executionMs}ms)`,
          matchedEntities: {},
        })

        if (toolResult.rows.length === 0) {
          setEmptyResultExplanation(toolResult.metadata.warning ?? 'No data found for this query.')
          return
        }

        // Fleet search — skip LLM entirely; the card grid shows all details already.
        // Calling Ollama to narrate 10–500 rows causes a consistent timeout.
        if (request.intent === 'fleet_search') {
          const n = toolResult.rows.length
          setInsight(`Found **${n}** site${n !== 1 ? 's' : ''} matching your criteria. Results shown below.`)
          setHistory((h) => [{
            question: q,
            answer: `tool:${request.tool}`,
            sql: toolResult.metadata.sql,
            resultSummary: `${toolResult.metadata.rowCount} rows`,
            timestamp: Date.now(),
          }, ...h].slice(0, 20))
          return
        }

        setInsightLoading(true)
        let narrativeSummary = ''
        try {
          await explainResultStream(q, request, toolResult, getOllamaProvider(), (token) => {
            narrativeSummary += token
            setInsight((prev) => prev + token)
          })
        } catch {
          narrativeSummary = buildFallbackSummary(toolResult, request)
          setInsight(narrativeSummary)
        } finally {
          setInsightLoading(false)
        }

        // Save site analysis turn for conversation context
        if (request.intent === 'site_analysis' && narrativeSummary) {
          setSiteAnalysisContext((prev) => [
            ...prev,
            {
              question: q,
              answerSummary: narrativeSummary.slice(0, 400),
            },
          ].slice(-3))
        }

        setHistory((h) => [{
          question: q,
          answer: `tool:${request.tool}`,
          sql: toolResult.metadata.sql,
          resultSummary: `${toolResult.metadata.rowCount} rows`,
          timestamp: Date.now(),
        }, ...h].slice(0, 20))
      } catch (err) {
        if (err instanceof ToolNotFoundError || err instanceof ToolParamError) {
          setQueryError(`Tool error: ${err.message}`)
        } else {
          setQueryError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setQueryLoading(false)
      }
    },
    [isTelemetryLoaded, isFleetLoaded]
  )

  const runQuestion = useCallback(
    async (q: string) => {
      if (!q.trim()) return

      // ── New tool-driven engine (opt-in via VITE_NEW_QUERY_ENGINE=true) ──
      if (USE_NEW_ENGINE) {
        await runWithNewEngine(q)
        return
      }

      // ── Follow-up: "more rows" / "show 100 rows" re-runs the last SQL with a new LIMIT ──
      if (!apiQuestion.enabled && isMoreRowsRequest(q)) {
        const lastWithSql = history.find((h) => h.sql)
        if (lastWithSql?.sql) {
          const newLimit = extractLimit(q, 100)
          const newSql = replaceLimitInSql(lastWithSql.sql, newLimit)
          setQueryLoading(true)
          setQueryError(null)
          setRows(null)
          setInsight('')
          setShowChart(false)
          try {
            await executeParsed(
              { sql: newSql, confidence: 'high', explanation: `Showing up to ${newLimit} rows.`, matchedEntities: {} },
              q,
              { ...dictionaries },
              queryTarget,
            )
          } catch (err) {
            setQueryError(err instanceof Error ? err.message : String(err))
          } finally {
            setQueryLoading(false)
          }
          return
        }
      }

      if (apiQuestion.enabled) {
        setQueryError(null)
        setRows(null)
        setPendingParsed(null)
        setShowExamples(false)
        try {
          const response = await apiQuestion.ask(q)
          const clarification = response.artifacts.find((artifact) => artifact.artifact_type === 'clarification')
          const fleetResult = response.artifacts.find((artifact) => artifact.artifact_type === 'fleet_result')
          if (clarification) {
            const detail = typeof clarification.payload.question === 'string'
              ? clarification.payload.question
              : 'Additional scope is required before this question can run.'
            setQueryError(detail)
            return
          }
          const resultRows = fleetResult?.payload.rows
          if (Array.isArray(resultRows)) {
            setRows(resultRows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null))
          }
          setResult({
            sql: 'Server-side governed query',
            confidence: response.run.status === 'completed' ? 'high' : 'medium',
            explanation: response.run.status === 'completed' ? 'Server-side fleet analysis' : 'Server-side analysis completed',
            matchedEntities: {},
          })
          setHistory((historyItems) => [{ question: q, answer: response.run.status, timestamp: Date.now() }, ...historyItems].slice(0, 20))
        } catch {
          setQueryError(apiQuestion.error ?? 'The Ask API could not complete this question.')
        }
        return
      }
      setQueryLoading(true)
      setQueryError(null)
      setRows(null)
      setInsight('')
      setEmptyResultExplanation(null)
      setIsOfflineFallback(false)
      setShowChart(false)
      setPendingParsed(null)
      setShowExamples(false)

      // Smart routing: detect fleet vs telemetry
      const target = routeQuestion(q, isFleetLoaded, isTelemetryLoaded)
      setQueryTarget(target)

      if (target === 'telemetry' && !isTelemetryLoaded) {
        setQueryError('Upload telemetry data first to ask questions about inverter performance. Go to the Upload page to import your CSV/Excel files.')
        setQueryLoading(false)
        return
      }

      if (target === 'fleet' && !dictionaries) {
        setQueryLoading(false)
        return
      }

      try {
        let parsed: ParsedQuery
        let activeDicts: Record<string, string[]>

        if (target === 'both') {
          const tDicts = telemetryDicts ?? await loadTelemetryDictionaries()
          activeDicts = { ...dictionaries, ...tDicts }
        } else if (target === 'telemetry') {
          const tDicts = telemetryDicts ?? await loadTelemetryDictionaries()
          activeDicts = { ...tDicts }
        } else {
          activeDicts = { ...dictionaries }
        }

        // ── Cache check: skip Ollama entirely for recently seen questions ──
        const cacheKey = `${q.trim().toLowerCase()}|${target}`
        const cached = queryCache.current.get(cacheKey)
        if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
          setResult(cached.parsed)
          setRows(cached.rows)
          setQueryLoading(false)
          return
        }

        // ── Primary path: always try Ollama first ──
        let ollamaError: string | null = null
        try {
          let stats: DataStats | undefined
          if (target === 'telemetry' || target === 'both') {
            try {
              const [countRes, rangeRes] = await Promise.all([
                query<{ cnt: number; sc: number; ic: number }>('SELECT COUNT(*) AS cnt, COUNT(DISTINCT site_id) AS sc, COUNT(DISTINCT serial_number) AS ic FROM telemetry'),
                query<{ d1: string; d2: string }>('SELECT CAST(MIN(timestamp) AS VARCHAR) AS d1, CAST(MAX(timestamp) AS VARCHAR) AS d2 FROM telemetry'),
              ])
              if (countRes[0]) {
                stats = {
                  totalRows: Number(countRes[0].cnt),
                  siteCount: Number(countRes[0].sc),
                  inverterCount: Number(countRes[0].ic),
                  dateFrom: rangeRes[0]?.d1 ?? undefined,
                  dateTo: rangeRes[0]?.d2 ?? undefined,
                }
              }
            } catch { /* stats optional */ }
          }
          parsed = await fetchLLMFallback(q, activeDicts, target, stats, conversationHistory)
        } catch (llmErr) {
          ollamaError = llmErr instanceof Error ? llmErr.message : String(llmErr)
          // ── Offline fallback: rule-based parsers ──
          if (!ollamaError.includes('Cannot reach Ollama') && !ollamaError.includes('Ollama error')) {
            throw new Error(ollamaError) // non-connectivity error — propagate
          }
          setIsOfflineFallback(true)
          if (target === 'both') {
            throw new Error(`Cross-table query requires Ollama. ${ollamaError}`)
          } else if (target === 'telemetry') {
            const tDicts = telemetryDicts ?? await loadTelemetryDictionaries()
            parsed = parseTelemetryQuestion(q, tDicts)
          } else {
            parsed = parseFleetQuestion(q, dictionaries!)
          }
        }

        // If the query needs time clarification, pause and ask
        if (parsed.needsClarification) {
          setPendingParsed(parsed)
          setPendingQuestion(q)
          setResult(parsed)
          return
        }

        await executeParsed(parsed, q, activeDicts, target)

        // ── Store in cache after successful execution ──
        setRows((currentRows) => {
          if (currentRows) {
            queryCache.current.set(cacheKey, { parsed, rows: currentRows, ts: Date.now() })
            // Evict oldest entries if cache grows beyond 15 items
            if (queryCache.current.size > 15) {
              const oldest = [...queryCache.current.entries()].sort(([,a],[,b]) => a.ts - b.ts)[0]
              if (oldest) queryCache.current.delete(oldest[0])
            }
          }
          return currentRows
        })
      } catch (err) {
        setQueryError(err instanceof Error ? err.message : String(err))
      } finally {
        setQueryLoading(false)
      }
    },
    [apiQuestion, dictionaries, telemetryDicts, isFleetLoaded, isTelemetryLoaded, executeParsed, conversationHistory]
  )

  /** Handle quarter selection from clarification */
  const handleQuarterSelect = useCallback(
    async (quarterValue: string) => {
      if (!pendingParsed || !dictionaries) return
      setQueryLoading(true)
      setQueryError(null)
      setRows(null)

      try {
        const isAll = quarterValue.toLowerCase().includes('all')
        let refinedQ = pendingQuestion
        if (!isAll) {
          refinedQ = `${pendingQuestion} in ${quarterValue}`
        }

        let parsed = parseFleetQuestion(refinedQ, dictionaries)
        // If still low confidence and same as pending, inject the quarter filter manually
        if (!isAll && !parsed.matchedEntities['quarter_first_interval']) {
          const sql = pendingParsed.sql.includes('WHERE')
            ? pendingParsed.sql.replace(/WHERE\s+/i, `WHERE quarter_first_interval = '${quarterValue}' AND `)
            : pendingParsed.sql
          parsed = { ...pendingParsed, sql, needsClarification: undefined }
        } else if (isAll) {
          parsed = { ...pendingParsed, needsClarification: undefined }
        }

        setPendingParsed(null)
        await executeParsed(parsed, `${pendingQuestion} (${quarterValue})`, { ...dictionaries }, 'fleet')
      } catch (err) {
        setQueryError(err instanceof Error ? err.message : String(err))
      } finally {
        setQueryLoading(false)
      }
    },
    [pendingParsed, pendingQuestion, dictionaries, executeParsed]
  )

  const handleSubmit = useCallback(() => {
    runQuestion(question)
  }, [question, runQuestion])

  const isQuestionLoading = queryLoading || apiQuestion.isLoading
  const columns = rows && rows.length > 0 ? Object.keys(rows[0]) : []

  if (fleetError && !apiQuestion.enabled) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">Failed to load fleet data</p>
          <p className="mt-1 text-sm">{fleetError instanceof Error ? fleetError.message : String(fleetError)}</p>
          <p className="mt-2 text-xs opacity-75">To regenerate fleet data: <code className="rounded bg-red-100 px-1 dark:bg-red-900">py scripts/prepare_fleet_data.py</code> then restart the dev server.</p>
        </div>
      </div>
    )
  }

  if (!apiQuestion.enabled && (fleetLoading || !isFleetLoaded)) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading fleet dataset… (this may take 10–20 s for a large parquet)
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Ask a Question</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Powered by {currentProviderLabel()} · model: <span className="font-mono font-medium">{currentProviderModel()}</span>
            {' · '}
            <OllamaSettingsDialog />
          </p>
        </div>
        {availableQuarters.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Data periods: <span className="font-medium text-foreground">{availableQuarters.join(', ')}</span>
          </div>
        )}
      </div>

      {/* Search input */}
      <Card>
        <CardContent className="space-y-3 pt-4 pb-4">
          <div className="flex gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder={isTelemetryLoaded ? 'e.g. "Inverters not crossing Vmp" or "DC AC ratio of North America"' : 'e.g. "DC AC ratio of North America" or "How many units in Europe in Q1 2025"'}
              className="flex-1"
            />
            <Button onClick={handleSubmit} disabled={!question.trim() || isQuestionLoading}>
              {isQuestionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Ask
            </Button>
          </div>

          {/* Collapsible example categories */}
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowExamples((v) => !v)}
          >
            {showExamples ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Example questions
          </button>
          {showExamples && (
            <div className="space-y-3">
              {isFleetLoaded && (
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Fleet Data</p>
                  <div className="space-y-2">
                    {EXAMPLE_CATEGORIES.map((cat) => (
                      <div key={cat.label}>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{cat.label}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {cat.questions.map((q) => (
                            <Badge
                              key={q}
                              variant="secondary"
                              className="cursor-pointer select-none text-xs"
                              onClick={() => { setQuestion(q); runQuestion(q) }}
                            >
                              {q}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {isTelemetryLoaded && (
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">Telemetry Data</p>
                  <div className="space-y-2">
                    {TELEMETRY_EXAMPLE_CATEGORIES.map((cat) => (
                      <div key={cat.label}>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{cat.label}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {cat.questions.map((q) => (
                            <Badge
                              key={q}
                              variant="outline"
                              className="cursor-pointer select-none text-xs border-blue-200 dark:border-blue-800"
                              onClick={() => { setQuestion(q); runQuestion(q) }}
                            >
                              {q}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data availability indicator */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-emerald-500" />
          <span className={isFleetLoaded ? 'text-foreground' : 'text-muted-foreground'}>
            Fleet {isFleetLoaded ? '✓' : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-blue-500" />
          <span className={isTelemetryLoaded ? 'text-foreground' : 'text-muted-foreground'}>
            Telemetry {isTelemetryLoaded ? '✓' : '—'}
          </span>
        </div>
        {queryTarget && result && (
          <Badge variant={queryTarget === 'telemetry' ? 'outline' : 'secondary'} className="text-[10px]">
            Queried: {queryTarget}
          </Badge>
        )}
      </div>

      {apiQuestion.enabled && (
        <p className="text-xs text-muted-foreground">Secure Azure Ask API mode is enabled.</p>
      )}

      {apiQuestion.enabled && apiQuestion.run && (
        <div className="space-y-4">
          <EvidencePanel
            runStatus={apiQuestion.run.status}
            runId={apiQuestion.run.id}
            artifactCount={apiQuestion.artifacts.length}
          />
          <ArtifactRenderer artifacts={apiQuestion.artifacts} />
        </div>
      )}

      {/* Clarification card — asking follow-up */}
      {pendingParsed?.needsClarification && !rows && !queryLoading && (
        <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30">
          <CardContent className="space-y-3 pt-4 pb-4">
            <div className="flex items-start gap-2">
              <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
              <div>
                <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
                  {pendingParsed.needsClarification.message}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {pendingParsed.needsClarification.options.map((opt) => (
                <Button
                  key={opt}
                  variant={opt === 'All periods' ? 'outline' : 'default'}
                  size="sm"
                  onClick={() => handleQuarterSelect(opt)}
                >
                  {opt === 'All periods' && <Clock className="mr-1 h-3.5 w-3.5" />}
                  {opt}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results card */}
      {(result || queryError || queryLoading) && (rows !== undefined || queryError || queryLoading) && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              {result?.explanation ?? (queryLoading ? 'Running…' : 'Error')}
            </CardTitle>
            <div className="flex items-center gap-2">
              {analysisRequest && !analysisRequest.unanswerable && (
                <Badge variant="outline" className="border-violet-300 text-violet-700 dark:border-violet-600 dark:text-violet-300 font-mono text-xs">
                  {analysisRequest.tool}
                </Badge>
              )}
              {isOfflineFallback && (
                <Badge variant="outline" className="border-orange-300 text-orange-600 dark:border-orange-700 dark:text-orange-400">
                  Offline mode
                </Badge>
              )}
              {result && (
              <Badge variant={
                result.confidence === 'high' ? 'default'
                : result.confidence === 'low' ? 'destructive'
                : 'secondary'
              } className={
                result.confidence === 'high' ? 'bg-green-600 hover:bg-green-700 text-white'
                : result.confidence === 'low' ? ''
                : ''
              }>
                {result.confidence === 'high' ? '✓ High confidence'
                 : result.confidence === 'low' ? '⚠ Low confidence — verify results'
                 : 'Medium confidence'}
              </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Unanswerable banner — prominent warning */}
            {result?.unanswerable && (
              <div className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>This question may not be fully answerable from the available data schema. Results shown are a best-effort approximation — please verify before acting on them.</span>
              </div>
            )}
            {/* Caveat / uncertainty notice */}
            {result?.caveat && !result?.unanswerable && (
              <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{result.caveat}</span>
              </div>
            )}

            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowSql((v) => !v)}
            >
              {showSql ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Generated SQL
            </button>
            {showSql && (
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{result?.sql}</pre>
            )}

            {queryLoading ? (
              <div className="flex items-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Running query…
              </div>
            ) : queryError ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p>{queryError}</p>
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Try rephrasing your question. Examples: "DC AC ratio of North America", "How many units in Europe", "Average irradiance in Brazil".
                  </p>
                </div>
              </div>
            ) : rows && rows.length === 0 ? (
              <div className="space-y-2 py-6">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-sm">No results found for these filters.</span>
                </div>
                {emptyResultExplanation && (
                  <p className="ml-6 text-xs text-muted-foreground italic">{emptyResultExplanation}</p>
                )}
              </div>
            ) : rows && rows.length > 0 ? (
              <>
                {/* Site analysis: dedicated structured renderer */}
                {analysisRequest?.intent === 'site_analysis' && rows.length === 1 && rows[0]['_analysis_type'] === 'comprehensive_site_analysis' ? (
                  <SiteAnalysisResult row={rows[0]} />
                ) : null}

                {/* Microinverter analysis: dedicated structured renderer */}
                {analysisRequest?.intent === 'microinverter_analysis' && rows.length === 1 && rows[0]['_analysis_type'] === 'microinverter_analysis' ? (
                  <MicroinverterAnalysisResult row={rows[0]} />
                ) : null}

                {/* Nearby sites: score-breakdown renderer */}
                {analysisRequest?.intent === 'nearby_sites' ? (
                  <NearbyResultRenderer rows={rows} />
                ) : null}

                {/* Fleet search: card-grid renderer */}
                {analysisRequest?.intent === 'fleet_search' ? (
                  <FleetSearchResult
                    rows={rows}
                    filters={(analysisRequest.filters ?? {}) as Record<string, unknown>}
                  />
                ) : null}

                {/* Summary stat cards for single-row aggregate results (non-site-analysis / non-nearby-sites) */}
                {!(analysisRequest?.intent === 'site_analysis') && !(analysisRequest?.intent === 'nearby_sites') && !(analysisRequest?.intent === 'fleet_search') && rows.length === 1 && columns.length <= 6 && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                    {columns.map((c) => (
                      <div key={c} className="rounded-lg border bg-muted/30 p-3 text-center">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{prettyCol(c)}</p>
                        <p className="mt-1 text-lg font-bold tabular-nums">{safeCell(rows[0][c], c)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Table for multi-row or many-column results (skip for site analysis, nearby sites, and fleet search) */}
                {!(analysisRequest?.intent === 'site_analysis') && !(analysisRequest?.intent === 'nearby_sites') && !(analysisRequest?.intent === 'fleet_search') && (rows.length > 1 || columns.length > 6) && (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {columns.map((c) => (
                            <TableHead key={c} className="whitespace-nowrap">{prettyCol(c)}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row, i) => (
                          <TableRow key={i}>
                            {columns.map((c) => (
                              <TableCell key={c} className="whitespace-nowrap">
                                {c === 'site_id' && row[c] != null ? (
                                  <a
                                    href={`https://enlighten.enphaseenergy.com/admin/sites/${encodeURIComponent(String(row[c]))}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                                  >
                                    {String(row[c])}
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                  </a>
                                ) : (
                                  safeCell(row[c], c)
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {rows.length} row{rows.length > 1 ? 's' : ''} returned
                    </p>
                  </div>
                )}

                {/* Chart suggestion for multi-row results */}
                {rows.length > 1 && (() => {
                  const TIME_COL_NAMES = ['date', 'hour', 'day', 'month', 'local_date', 'hour_of_day', 'timestamp']
                  const xCol = columns.find((c) => TIME_COL_NAMES.includes(c.toLowerCase()))
                    ?? columns.find((c) => /date|hour|time|day|month/i.test(c))
                  const numCols = columns.filter((c) => c !== xCol && rows.some((r) => typeof r[c] === 'number' || (r[c] !== null && Number.isFinite(Number(r[c])))))
                  const labelCol = !xCol ? columns.find((c) => /site_id|serial_number|sku_name|name/i.test(c)) : undefined
                  const chartXCol = xCol ?? labelCol
                  if (!chartXCol || numCols.length === 0) return null
                  return (
                    <div className="mt-3 space-y-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={() => setShowChart((v) => !v)}
                      >
                        <BarChart3 className="h-3.5 w-3.5" />
                        {showChart ? 'Hide Chart' : 'View as Chart'}
                      </Button>
                      {showChart && (
                        <ReactECharts
                          style={{ height: 350 }}
                          option={{
                            tooltip: { trigger: 'axis' },
                            legend: numCols.length > 1 ? { data: numCols.map(prettyCol), bottom: 0, type: 'scroll' } : undefined,
                            grid: { left: 60, right: 20, top: 20, bottom: numCols.length > 1 ? 40 : 30 },
                            xAxis: {
                              type: 'category',
                              data: rows.map((r) => String(r[chartXCol] ?? '')),
                              axisLabel: { rotate: rows.length > 15 ? 45 : 0, fontSize: 10 },
                            },
                            yAxis: numCols.length <= 2
                              ? numCols.map((c, i) => ({
                                  type: 'value' as const,
                                  name: prettyCol(c),
                                  position: i === 0 ? 'left' as const : 'right' as const,
                                  nameTextStyle: { fontSize: 10 },
                                  axisLabel: { fontSize: 10 },
                                }))
                              : { type: 'value' },
                            series: numCols.slice(0, 5).map((c, i) => ({
                              name: prettyCol(c),
                              type: xCol ? 'line' as const : 'bar' as const,
                              data: rows.map((r) => Number(r[c]) || 0),
                              yAxisIndex: numCols.length <= 2 ? i : 0,
                              smooth: true,
                            })),
                          }}
                        />
                      )}
                    </div>
                  )
                })()}
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* AI Insight — streaming */}
      {(insight || insightLoading) && (
        <Card className="border-purple-200 bg-purple-50/50 dark:border-purple-800 dark:bg-purple-950/30">
          <CardContent className="flex items-start gap-2 pt-4 pb-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">AI Insight</p>
              <div className="mt-1 text-sm leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: renderMarkdown(insight) }} />
                {insightLoading && (
                  <span className="inline-block ml-0.5 h-3.5 w-0.5 animate-pulse bg-purple-500 align-text-bottom" />
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Conversation history */}
      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
              Recent Questions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {history.map((h, i) => (
              <button
                key={i}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50"
                onClick={() => {
                  setQuestion(h.question)
                  runQuestion(h.question)
                }}
              >
                <Search className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{h.question}</p>
                  <p className="text-muted-foreground truncate">{h.answer}</p>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
