/**
 * Model benchmarking script — evaluates intent router accuracy against
 * docs/benchmark/questions.json using the configured Ollama model.
 *
 * Usage (run via tsx or ts-node from the project root):
 *   npx tsx scripts/benchmark_model.ts
 *   npx tsx scripts/benchmark_model.ts --model qwen2.5-coder:7b --concurrency 1
 *
 * Outputs a JSON report to docs/benchmark/results_<model>_<timestamp>.json
 * and a summary table to stdout.
 *
 * Dependencies (already in project): fetch (Node 18+ built-in), fs, path.
 * No new npm installs required.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

const BENCHMARK_FILE = path.join(PROJECT_ROOT, 'docs', 'benchmark', 'questions.json')
const RESULTS_DIR    = path.join(PROJECT_ROOT, 'docs', 'benchmark')

const DEFAULT_MODEL        = 'qwen2.5-coder:7b'
const DEFAULT_OLLAMA_URL   = 'http://localhost:11434'
const DEFAULT_CONCURRENCY  = 1    // keep at 1 for 7B on 16GB RAM
const TIMEOUT_MS           = 45_000

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): { model: string; ollamaUrl: string; concurrency: number; filterCategory?: string } {
  const args = process.argv.slice(2)
  const get = (flag: string, def: string): string => {
    const i = args.indexOf(flag)
    return i !== -1 && args[i + 1] ? args[i + 1] : def
  }
  return {
    model:          get('--model', DEFAULT_MODEL),
    ollamaUrl:      get('--ollama-url', DEFAULT_OLLAMA_URL),
    concurrency:    parseInt(get('--concurrency', String(DEFAULT_CONCURRENCY)), 10),
    filterCategory: args.includes('--category') ? args[args.indexOf('--category') + 1] : undefined,
  }
}

// ─── Benchmark question schema ────────────────────────────────────────────────

interface BenchmarkQuestion {
  id: string
  category: string
  q: string
  tool: string
  intent: string
  metric?: string
  groupBy?: string[]
}

interface BenchmarkFile {
  _meta: { version: string; total: number }
  questions: BenchmarkQuestion[]
}

// ─── LLM call (mirrors llmProvider.ts logic — standalone, no Vite imports) ───

interface OllamaResponse {
  message?: { content?: string }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}

async function callOllama(
  prompt: string,
  system: string,
  model: string,
  ollamaUrl: string
): Promise<{ text: string; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const t0 = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const resp = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: prompt },
        ],
        stream: false,
        options: { temperature: 0, num_predict: 512 },
        format: 'json',
      }),
      signal: controller.signal,
    })

    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`)
    const data = await resp.json() as OllamaResponse
    return {
      text: data.message?.content ?? '',
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      latencyMs: Date.now() - t0,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Minimal system prompt (subset of intentRouter.ts) ───────────────────────

const SYSTEM_PROMPT = `You are an analytics orchestrator. Output ONLY valid JSON:
{
  "intent": "<fleet_summary|site_summary|product_summary|region_summary|dc_ac_ratio|energy_total|energy_compare|energy_per_inverter|telemetry_stats|time_series|telemetry_compare|clipping|inverter_utilization|anomaly_detect|inverter_drilldown|unanswerable>",
  "tool": "<tool_name or empty string>",
  "confidence": "<high|medium|low>"
}

TOOL→INTENT MAPPING:
get_fleet_summary → fleet_summary
get_site_summary → site_summary
get_product_summary → product_summary
get_region_summary → region_summary
get_dc_ac_ratio → dc_ac_ratio
calculate_energy → energy_total
compare_energy → energy_compare
calculate_energy_per_inverter → energy_per_inverter
get_telemetry_statistics → telemetry_stats
get_time_series → time_series
compare_telemetry → telemetry_compare
calculate_clipping → clipping
calculate_inverter_utilization → inverter_utilization
detect_anomalies → anomaly_detect
get_inverter_drilldown → inverter_drilldown
(unanswerable for anything not in available data)

IMPORTANT: output ONLY the JSON object, no markdown.`

// ─── Result types ─────────────────────────────────────────────────────────────

interface QuestionResult {
  id: string
  category: string
  question: string
  expectedTool: string
  expectedIntent: string
  predictedTool: string
  predictedIntent: string
  confidence: string
  toolMatch: boolean
  intentMatch: boolean
  latencyMs: number
  promptTokens: number
  completionTokens: number
  rawResponse: string
  error?: string
}

interface BenchmarkReport {
  model: string
  ollamaUrl: string
  timestamp: string
  totalQuestions: number
  toolAccuracy: number
  intentAccuracy: number
  avgLatencyMs: number
  p50LatencyMs: number
  p90LatencyMs: number
  avgPromptTokens: number
  avgCompletionTokens: number
  byCategory: Record<string, { total: number; toolMatch: number; intentMatch: number; toolAccuracy: number; intentAccuracy: number }>
  errors: number
  results: QuestionResult[]
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

function extractJson(raw: string): { intent?: string; tool?: string; confidence?: string } | null {
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    return JSON.parse(raw.slice(start, end + 1)) as { intent?: string; tool?: string; confidence?: string }
  } catch {
    return null
  }
}

async function evaluateQuestion(
  q: BenchmarkQuestion,
  model: string,
  ollamaUrl: string
): Promise<QuestionResult> {
  const base: Omit<QuestionResult, 'predictedTool' | 'predictedIntent' | 'confidence' | 'toolMatch' | 'intentMatch' | 'latencyMs' | 'promptTokens' | 'completionTokens' | 'rawResponse'> = {
    id: q.id,
    category: q.category,
    question: q.q,
    expectedTool: q.tool,
    expectedIntent: q.intent,
  }

  let llmResult: { text: string; promptTokens: number; completionTokens: number; latencyMs: number }
  try {
    llmResult = await callOllama(q.q, SYSTEM_PROMPT, model, ollamaUrl)
  } catch (err) {
    return {
      ...base,
      predictedTool: '',
      predictedIntent: '',
      confidence: 'low',
      toolMatch: false,
      intentMatch: false,
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      rawResponse: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const parsed = extractJson(llmResult.text)
  const predictedTool   = parsed?.tool    ?? ''
  const predictedIntent = parsed?.intent  ?? ''
  const confidence      = parsed?.confidence ?? 'low'

  return {
    ...base,
    predictedTool,
    predictedIntent,
    confidence,
    toolMatch:   predictedTool   === q.tool,
    intentMatch: predictedIntent === q.intent,
    latencyMs:   llmResult.latencyMs,
    promptTokens:     llmResult.promptTokens,
    completionTokens: llmResult.completionTokens,
    rawResponse: llmResult.text,
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

async function runBenchmark(): Promise<void> {
  const { model, ollamaUrl, concurrency, filterCategory } = parseArgs()

  // Load questions
  const benchmarkData: BenchmarkFile = JSON.parse(fs.readFileSync(BENCHMARK_FILE, 'utf-8'))
  let questions = benchmarkData.questions
  if (filterCategory) questions = questions.filter((q) => q.category === filterCategory)

  console.log(`\n=== CompDash GPT Model Benchmark ===`)
  console.log(`Model:       ${model}`)
  console.log(`Ollama URL:  ${ollamaUrl}`)
  console.log(`Questions:   ${questions.length}${filterCategory ? ` (category: ${filterCategory})` : ''}`)
  console.log(`Concurrency: ${concurrency}`)
  console.log(`=====================================\n`)

  // Run evaluations (sequential by default — safe for 16GB RAM)
  const results: QuestionResult[] = []
  for (let i = 0; i < questions.length; i += concurrency) {
    const batch = questions.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map((q) => evaluateQuestion(q, model, ollamaUrl))
    )
    results.push(...batchResults)

    const done = i + batch.length
    const correct = results.filter((r) => r.toolMatch).length
    const pct = ((correct / done) * 100).toFixed(1)
    process.stdout.write(`\r[${done}/${questions.length}] Tool accuracy so far: ${pct}%   `)
  }
  console.log('\n')

  // Compute report
  const latencies = results.map((r) => r.latencyMs).filter((l) => l > 0).sort((a, b) => a - b)
  const byCategory: BenchmarkReport['byCategory'] = {}
  for (const r of results) {
    const cat = byCategory[r.category] ?? { total: 0, toolMatch: 0, intentMatch: 0, toolAccuracy: 0, intentAccuracy: 0 }
    cat.total++
    if (r.toolMatch) cat.toolMatch++
    if (r.intentMatch) cat.intentMatch++
    byCategory[r.category] = cat
  }
  for (const cat of Object.values(byCategory)) {
    cat.toolAccuracy   = cat.total > 0 ? (cat.toolMatch   / cat.total) * 100 : 0
    cat.intentAccuracy = cat.total > 0 ? (cat.intentMatch / cat.total) * 100 : 0
  }

  const toolCorrect   = results.filter((r) => r.toolMatch).length
  const intentCorrect = results.filter((r) => r.intentMatch).length
  const errors        = results.filter((r) => r.error).length
  const avgLatency    = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0
  const avgPrompt     = results.reduce((s, r) => s + r.promptTokens, 0) / results.length
  const avgCompletion = results.reduce((s, r) => s + r.completionTokens, 0) / results.length

  const report: BenchmarkReport = {
    model,
    ollamaUrl,
    timestamp: new Date().toISOString(),
    totalQuestions: questions.length,
    toolAccuracy:   (toolCorrect   / questions.length) * 100,
    intentAccuracy: (intentCorrect / questions.length) * 100,
    avgLatencyMs:   Math.round(avgLatency),
    p50LatencyMs:   percentile(latencies, 50),
    p90LatencyMs:   percentile(latencies, 90),
    avgPromptTokens:     Math.round(avgPrompt),
    avgCompletionTokens: Math.round(avgCompletion),
    byCategory,
    errors,
    results,
  }

  // Print summary
  console.log('=== RESULTS ===')
  console.log(`Tool accuracy:   ${report.toolAccuracy.toFixed(1)}%  (${toolCorrect}/${questions.length})`)
  console.log(`Intent accuracy: ${report.intentAccuracy.toFixed(1)}%  (${intentCorrect}/${questions.length})`)
  console.log(`Avg latency:     ${report.avgLatencyMs}ms  (p50=${report.p50LatencyMs}ms, p90=${report.p90LatencyMs}ms)`)
  console.log(`Avg tokens:      ${report.avgPromptTokens} prompt / ${report.avgCompletionTokens} completion`)
  console.log(`Errors:          ${errors}`)
  console.log('\nBy category:')
  for (const [cat, stats] of Object.entries(byCategory)) {
    console.log(`  ${cat.padEnd(14)} tool=${stats.toolAccuracy.toFixed(1)}%  intent=${stats.intentAccuracy.toFixed(1)}%  (n=${stats.total})`)
  }

  // Print misses
  const misses = results.filter((r) => !r.toolMatch)
  if (misses.length > 0) {
    console.log('\nTool mismatches:')
    for (const m of misses.slice(0, 20)) {
      console.log(`  [${m.id}] Expected: ${m.expectedTool || '(none)'} | Got: ${m.predictedTool || '(none)'}`)
      console.log(`        Q: "${m.question.slice(0, 80)}"`)
      if (m.error) console.log(`        ERR: ${m.error}`)
    }
  }

  // Save report
  const safeModel = model.replace(/[/:]/g, '_')
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outFile = path.join(RESULTS_DIR, `results_${safeModel}_${ts}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`\nReport saved to: ${outFile}`)
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
