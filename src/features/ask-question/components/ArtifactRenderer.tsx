import { AlertTriangle, BarChart3, FileText, Lightbulb, MessageCircleQuestion, TableProperties } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { AskApiArtifact } from '../api/client'
import { ChartArtifact } from './ChartArtifact'
import { ServerResultGrid } from './ServerResultGrid'

interface ArtifactRendererProps {
  artifacts: AskApiArtifact[]
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

export function ArtifactRenderer({ artifacts }: ArtifactRendererProps) {
  return (
    <div className="space-y-4">
      {artifacts.map((artifact) => {
        if (artifact.artifact_type === 'fleet_result') {
          const rows = asRows(artifact.payload.rows)
          const unit = typeof artifact.payload.metric_unit === 'string' ? artifact.payload.metric_unit : undefined
          if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
            const value = rows[0].result
            return (
              <Card key={artifact.id}>
                <CardHeader><CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="h-4 w-4 text-primary" /> {artifact.title}</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold tabular-nums">{typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(value ?? '—')}</p>
                  {unit && <p className="mt-1 text-sm text-muted-foreground">{unit}</p>}
                </CardContent>
              </Card>
            )
          }
          return (
            <Card key={artifact.id}>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TableProperties className="h-4 w-4 text-primary" /> {artifact.title}</CardTitle></CardHeader>
              <CardContent className="space-y-2"><ServerResultGrid rows={rows} /><p className="text-xs text-muted-foreground">{artifact.row_count ?? rows.length} row{(artifact.row_count ?? rows.length) === 1 ? '' : 's'} returned{unit ? ` · ${unit}` : ''}</p></CardContent>
            </Card>
          )
        }
        if (artifact.artifact_type === 'chart') {
          const specification = typeof artifact.payload.specification === 'object' && artifact.payload.specification !== null ? artifact.payload.specification as Record<string, unknown> : {}
          const summary = typeof artifact.payload.accessible_summary === 'string' ? artifact.payload.accessible_summary : artifact.title
          return <Card key={artifact.id}><CardHeader><CardTitle>{artifact.title}</CardTitle></CardHeader><CardContent><ChartArtifact specification={specification} accessibleSummary={summary} /></CardContent></Card>
        }
        if (artifact.artifact_type === 'clarification') {
          const question = typeof artifact.payload.question === 'string' ? artifact.payload.question : 'Additional scope is required.'
          return <Card key={artifact.id} className="border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30"><CardContent className="flex gap-2 pt-4"><MessageCircleQuestion className="h-5 w-5 shrink-0 text-blue-600" /><p className="text-sm">{question}</p></CardContent></Card>
        }
        if (artifact.artifact_type === 'warning') {
          const message = typeof artifact.payload.message === 'string' ? artifact.payload.message : artifact.title
          return <Card key={artifact.id} className="border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"><CardContent className="flex gap-2 pt-4"><AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" /><p className="text-sm">{message}</p></CardContent></Card>
        }
        return <Card key={artifact.id}><CardContent className="flex gap-2 pt-4 text-sm"><Lightbulb className="h-4 w-4 text-primary" /><div><p className="font-medium">{artifact.title}</p><p className="text-muted-foreground"><FileText className="mr-1 inline h-3 w-3" />Server artifact: {artifact.artifact_type}</p></div></CardContent></Card>
      })}
    </div>
  )
}
