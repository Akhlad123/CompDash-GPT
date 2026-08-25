export type AnalysisConfidence = 'high' | 'medium' | 'low'
export type AnalysisRunStatus =
  | 'accepted'
  | 'clarification_required'
  | 'planning'
  | 'executing'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ArtifactType =
  | 'kpi'
  | 'table'
  | 'chart'
  | 'insight'
  | 'citation'
  | 'clarification'
  | 'warning'

export interface QuestionScope {
  siteIds?: string[]
  countries?: string[]
  regions?: string[]
  productTypes?: string[]
  startAt?: string
  endAt?: string
  timezone: string
}

export interface QuestionRequest {
  question: string
  scope: QuestionScope
  outputPreference?: 'auto' | 'summary' | 'table' | 'chart'
  clientRequestId: string
}

export interface AnalysisCitation {
  documentId: string
  title: string
  version?: string
  pageNumber?: number
  chunkId?: string
  sourceUrl?: string
}

export interface DataFreshness {
  source: string
  asOf: string
  status: 'fresh' | 'stale' | 'unknown'
}

export interface AnalysisAssumption {
  label: string
  detail: string
}

export interface KpiArtifact {
  type: 'kpi'
  id: string
  title: string
  value: number | string | null
  unit?: string
  change?: number
  detail?: string
}

export interface TableArtifact {
  type: 'table'
  id: string
  title: string
  columns: Array<{ key: string; label: string; unit?: string }>
  rowCount: number
  rowCursor?: string
}

export interface ChartArtifact {
  type: 'chart'
  id: string
  title: string
  chartType: 'line' | 'bar' | 'scatter' | 'area' | 'heatmap'
  specification: Record<string, unknown>
  accessibleSummary: string
}

export interface InsightArtifact {
  type: 'insight'
  id: string
  title: string
  content: string
}

export interface CitationArtifact {
  type: 'citation'
  id: string
  citation: AnalysisCitation
}

export interface ClarificationArtifact {
  type: 'clarification'
  id: string
  question: string
  field: 'time_range' | 'site' | 'region' | 'country' | 'product' | 'metric'
  options: Array<{ label: string; value: string }>
}

export interface WarningArtifact {
  type: 'warning'
  id: string
  title: string
  content: string
  severity: 'info' | 'warning' | 'error'
}

export type AnalysisArtifact =
  | KpiArtifact
  | TableArtifact
  | ChartArtifact
  | InsightArtifact
  | CitationArtifact
  | ClarificationArtifact
  | WarningArtifact

export interface AssistantResponse {
  narrative: string
  confidence: AnalysisConfidence
  uncertaintyReasons: string[]
  assumptions: AnalysisAssumption[]
  suggestedFollowUps: string[]
  freshness: DataFreshness[]
  citations: AnalysisCitation[]
  artifacts: AnalysisArtifact[]
}

export interface AnalysisRun {
  id: string
  conversationId: string
  status: AnalysisRunStatus
  requestId: string
  createdAt: string
  updatedAt: string
  response?: AssistantResponse
}

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  correlationId?: string
}
