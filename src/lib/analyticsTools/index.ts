// Analytics tool registry — single import point for all tools and the dispatcher map.

export type { AnalyticsTool, ToolResult, ToolMetadata } from './types'
export { MAX_RESULT_ROWS } from './types'

export {
  getFleetSummaryTool,
  getSiteSummaryTool,
  getProductSummaryTool,
  getRegionSummaryTool,
  getDcAcRatioTool,
  FLEET_TOOLS,
} from './fleetTools'

export {
  calculateEnergyTool,
  compareEnergyTool,
  energyPerInverterTool,
  ENERGY_TOOLS,
} from './energyTools'

export {
  getTelemetryStatsTool,
  getTimeSeriesParamsTool,
  compareTelemetryTool,
  TELEMETRY_TOOLS,
} from './telemetryTools'

export {
  calculateClippingTool,
  calculateUtilizationTool,
  detectAnomaliesTool,
  inverterDrilldownTool,
  PERFORMANCE_TOOLS,
} from './performanceTools'

export {
  analyzeSiteTool,
} from './siteAnalysisTool'

export {
  analyzeMicroinverterTool,
} from './microinverterAnalysisTool'

export {
  findNearbyTool,
} from './nearbyTool'

export {
  fleetSearchTool,
} from './fleetSearchTool'

import { FLEET_TOOLS } from './fleetTools'
import { ENERGY_TOOLS } from './energyTools'
import { TELEMETRY_TOOLS } from './telemetryTools'
import { PERFORMANCE_TOOLS } from './performanceTools'
import { analyzeSiteTool } from './siteAnalysisTool'
import { analyzeMicroinverterTool } from './microinverterAnalysisTool'
import { findNearbyTool } from './nearbyTool'
import { fleetSearchTool } from './fleetSearchTool'
import type { AnalyticsTool } from './types'

// ─── Unified registry ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_TOOLS: AnalyticsTool<any, any>[] = [
  ...FLEET_TOOLS,
  ...ENERGY_TOOLS,
  ...TELEMETRY_TOOLS,
  ...PERFORMANCE_TOOLS,
  analyzeSiteTool,
  analyzeMicroinverterTool,
  findNearbyTool,
  fleetSearchTool,
]

/** Look up a tool by name. Returns undefined if not registered. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_REGISTRY: Map<string, AnalyticsTool<any, any>> = new Map(
  ALL_TOOLS.map((t) => [t.name, t])
)

/**
 * Compact one-liner per tool — injected into the Stage 1 LLM system prompt
 * so the model knows what tools are available and what they do.
 */
export function buildToolList(): string {
  return ALL_TOOLS
    .map((t) => `  ${t.name}: ${t.description}`)
    .join('\n')
}
