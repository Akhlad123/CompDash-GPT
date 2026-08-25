import { Database, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface EvidencePanelProps {
  runStatus: string
  runId: string
  artifactCount: number
}

export function EvidencePanel({ runStatus, runId, artifactCount }: EvidencePanelProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
      <Badge variant="outline" className="gap-1">
        <ShieldCheck className="h-3 w-3" /> Governed server analysis
      </Badge>
      <span className="flex items-center gap-1"><Database className="h-3 w-3" /> {artifactCount} artifact{artifactCount === 1 ? '' : 's'}</span>
      <span>Status: <span className="font-medium text-foreground">{runStatus.replace(/_/g, ' ')}</span></span>
      <span className="font-mono">Run {runId.slice(0, 8)}</span>
    </div>
  )
}
