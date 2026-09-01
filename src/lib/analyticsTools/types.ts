// Shared types for all analytics tools.
// Every tool is a typed function: validate params → build safe query → execute → return result.

import { z } from 'zod'

export interface ToolMetadata {
  tool: string
  params: Record<string, unknown>
  sql?: string
  executionMs: number
  rowCount: number
  warning?: string
}

export interface ToolResult<T = Record<string, unknown>> {
  rows: T[]
  metadata: ToolMetadata
}

export interface AnalyticsTool<P, R = Record<string, unknown>> {
  /** Machine name — also the value the LLM puts in AnalysisRequest.tool */
  name: string
  /** One-line description injected into the Stage 1 LLM system prompt */
  description: string
  /** Zod schema that validates LLM-supplied params before any SQL is built */
  parametersSchema: z.ZodSchema<P>
  /** Executes the tool and returns validated, row-capped results */
  execute: (params: P) => Promise<ToolResult<R>>
}

/** Hard cap on result rows returned to the UI layer */
export const MAX_RESULT_ROWS = 10000
