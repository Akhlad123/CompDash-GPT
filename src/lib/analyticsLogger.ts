// Observability logger for the new analytics engine.
// Writes structured events to sessionStorage (dev) and/or console.
// No PII — question text is stored only in dev mode, never in production builds.
// Enable verbose mode via VITE_ANALYTICS_DEBUG=true.

export interface AnalyticsEvent {
  sessionId: string
  eventId: string
  ts: number
  question: string         // stored only in dev mode
  intent: string | null
  tool: string | null
  toolParams: Record<string, unknown>
  intentLatencyMs: number | null
  toolLatencyMs: number | null
  explainerLatencyMs: number | null
  resultRowCount: number
  promptTokens?: number
  completionTokens?: number
  confidence: 'high' | 'medium' | 'low' | null
  error?: string
  engineMode: 'new' | 'legacy'
}

// ─── Session ID ───────────────────────────────────────────────────────────────

function getOrCreateSessionId(): string {
  const key = 'analytics_session_id'
  const stored = sessionStorage.getItem(key)
  if (stored) return stored
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  sessionStorage.setItem(key, id)
  return id
}

const SESSION_ID = getOrCreateSessionId()
const IS_DEBUG = import.meta.env['VITE_ANALYTICS_DEBUG'] === 'true'
const IS_DEV = import.meta.env.DEV === true

// ─── Event log (in-memory, max 200 events) ────────────────────────────────────

const EVENT_LOG: AnalyticsEvent[] = []
const MAX_LOG_SIZE = 200

// ─── Logger ───────────────────────────────────────────────────────────────────

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Log a completed analytics engine interaction.
 * In production builds, `question` is replaced with `[redacted]`.
 */
export function logAnalyticsEvent(event: Omit<AnalyticsEvent, 'sessionId' | 'eventId' | 'ts'>): void {
  const full: AnalyticsEvent = {
    ...event,
    sessionId: SESSION_ID,
    eventId: generateEventId(),
    ts: Date.now(),
    question: IS_DEV ? event.question : '[redacted]',
  }

  if (EVENT_LOG.length >= MAX_LOG_SIZE) EVENT_LOG.shift()
  EVENT_LOG.push(full)

  if (IS_DEBUG || IS_DEV) {
    console.group(`[Analytics] ${full.intent ?? 'unknown'} → ${full.tool ?? 'none'}`)
    console.log('question:', full.question)
    console.log('confidence:', full.confidence)
    console.log('rows:', full.resultRowCount)
    console.log('latency: intent=%dms tool=%dms explainer=%dms',
      full.intentLatencyMs, full.toolLatencyMs, full.explainerLatencyMs)
    if (full.error) console.warn('error:', full.error)
    console.groupEnd()
  }
}

/** Returns all logged events for the current session (for debug panels). */
export function getEventLog(): readonly AnalyticsEvent[] {
  return EVENT_LOG
}

/** Clears the in-memory event log. */
export function clearEventLog(): void {
  EVENT_LOG.length = 0
}

/** Returns a summary of event log stats for display in a debug panel. */
export function getLogStats(): {
  totalEvents: number
  successRate: number
  avgIntentLatencyMs: number
  avgToolLatencyMs: number
  topTools: Array<{ tool: string; count: number }>
} {
  const total = EVENT_LOG.length
  if (total === 0) return { totalEvents: 0, successRate: 0, avgIntentLatencyMs: 0, avgToolLatencyMs: 0, topTools: [] }

  const successful = EVENT_LOG.filter((e) => !e.error).length
  const intentLatencies = EVENT_LOG.map((e) => e.intentLatencyMs ?? 0).filter(Boolean)
  const toolLatencies = EVENT_LOG.map((e) => e.toolLatencyMs ?? 0).filter(Boolean)

  const toolCounts = new Map<string, number>()
  for (const e of EVENT_LOG) {
    if (e.tool) toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1)
  }
  const topTools = [...toolCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tool, count]) => ({ tool, count }))

  const avg = (arr: number[]): number => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0

  return {
    totalEvents: total,
    successRate: total > 0 ? (successful / total) * 100 : 0,
    avgIntentLatencyMs: Math.round(avg(intentLatencies)),
    avgToolLatencyMs: Math.round(avg(toolLatencies)),
    topTools,
  }
}
