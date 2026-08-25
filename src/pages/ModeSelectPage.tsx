import { useNavigate } from 'react-router-dom'
import { Boxes, Cpu, Layers, Zap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useAppModeStore } from '@/store/appModeStore'

const options = [
  {
    mode: 'fleet' as const,
    icon: Boxes,
    title: 'Fleet Analytics',
    description:
      'Explore wafer and power-bucket breakdowns across region, country, and quarter using the bundled Fleet dataset. No upload needed.',
    to: '/fleet',
  },
  {
    mode: 'telemetry' as const,
    icon: Cpu,
    title: 'Telemetry Analysis',
    description:
      'Upload microinverter telemetry data (CSV/Excel) to analyze site comparisons, inverter drilldowns, time series, and anomalies.',
    to: '/upload',
  },
  {
    mode: 'both' as const,
    icon: Layers,
    title: 'Both',
    description:
      'Use Fleet Analytics and Telemetry Analysis together — sites present in both datasets are cross-linked by Site ID for enriched context.',
    to: '/upload',
  },
]

export default function ModeSelectPage() {
  const navigate = useNavigate()
  const setMode = useAppModeStore((s) => s.setMode)

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-10 bg-background px-6 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2">
          <Zap className="h-8 w-8 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">CompDash GPT</h1>
        </div>
        <p className="max-w-md text-sm text-muted-foreground">
          Fleet analytics, telemetry comparison, and natural-language querying —
          choose how you want to start.
        </p>
      </div>

      <div className="grid w-full max-w-4xl gap-6 sm:grid-cols-3">
        {options.map(({ mode, icon: Icon, title, description, to }) => (
          <Card
            key={mode}
            className="cursor-pointer transition-colors hover:border-primary hover:shadow-md"
            onClick={() => {
              setMode(mode)
              navigate(to)
            }}
          >
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent />
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        All data stays in your browser. Fleet data is confidential and never leaves this machine.
      </p>
    </div>
  )
}
