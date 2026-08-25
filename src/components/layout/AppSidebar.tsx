import { useCallback } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  Upload,
  BarChart3,
  GitCompareArrows,
  Cpu,
  AlertTriangle,
  Scissors,
  Sparkles,
  Trash2,
  Code2,
  Rows3,
  Boxes,
  Layers3,
  PieChart,
  MessageCircleQuestion,
  ArrowRight,
  ShieldAlert,
  Home,
  Database,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { clearSession } from '@/lib/sessionStore'
import { useDataStore } from '@/store/dataStore'
import { useAppModeStore } from '@/store/appModeStore'
import ThemeToggle from '@/components/layout/ThemeToggle'

const fleetNavItems = [
  { to: '/data', label: 'Data Sources', icon: Database },
  { to: '/fleet', label: 'Fleet Overview', icon: Boxes },
  { to: '/fleet/wafer', label: 'Wafer Detail', icon: Layers3 },
  { to: '/fleet/products', label: 'Product Bucket', icon: PieChart },
  { to: '/fleet/chart', label: 'Summary Chart', icon: BarChart3 },
  { to: '/fleet/transition', label: 'Transition Analytics', icon: ArrowRight },
  { to: '/fleet/compliance', label: 'Compliance Check', icon: ShieldAlert },
  { to: '/fleet/query', label: 'Ask a Question', icon: MessageCircleQuestion },
]

const telemetryNavItems = [
  { to: '/upload', label: 'Upload', icon: Upload },
  { to: '/overview', label: 'Overview', icon: BarChart3 },
  { to: '/sites', label: 'Site Comparison', icon: GitCompareArrows },
  { to: '/inverters', label: 'Inverter Drilldown', icon: Cpu },
  { to: '/anomaly', label: 'Anomaly Detection', icon: AlertTriangle },
  { to: '/clipping', label: 'Clipping Analysis', icon: Scissors },
  { to: '/buckets', label: 'Bucket Analysis', icon: Rows3 },
  { to: '/developer', label: 'Developer Mode', icon: Code2 },
]

export default function AppSidebar() {
  const navigate = useNavigate()
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const resetData = useDataStore((s) => s.resetData)
  const mode = useAppModeStore((s) => s.mode)
  const setMode = useAppModeStore((s) => s.setMode)

  const showFleet = mode === 'fleet' || mode === 'both'
  const showTelemetry = mode === 'telemetry' || mode === 'both' || mode === null

  const handleClearSession = useCallback(async () => {
    await clearSession()
    resetData()
    navigate('/')
  }, [resetData, navigate])

  const handleChangeMode = useCallback(() => {
    setMode(null)
    navigate('/')
  }, [setMode, navigate])

  return (
    <aside className="flex h-full w-64 flex-shrink-0 flex-col border-r border-sidebar-border bg-sidebar-background">
      <div className="border-b border-sidebar-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-sidebar-primary" />
          <span className="text-lg font-semibold text-sidebar-foreground">
            CompDash GPT
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          AI-powered fleet analytics and microinverter telemetry, unified by Site ID.
        </p>
      </div>

      <nav className="scrollbar-visible flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {showFleet && (
          <>
            <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Fleet
            </p>
            {fleetNavItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/fleet'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </>
        )}

        {showTelemetry && (
          <>
            <p className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Telemetry
            </p>
            {telemetryNavItems.map(({ to, label, icon: Icon }) => {
              const requiresData = to !== '/upload'
              const disabled = requiresData && !isDataLoaded
              if (disabled) {
                return (
                  <span
                    key={to}
                    className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/50 cursor-not-allowed"
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </span>
                )
              }
              return (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/upload'}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                    )
                  }
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </NavLink>
              )
            })}
          </>
        )}
      </nav>

      <div className="space-y-2 border-t border-sidebar-border px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-xs text-muted-foreground"
          onClick={handleChangeMode}
        >
          <Home className="h-3.5 w-3.5" />
          Change Mode
        </Button>
        <ThemeToggle />
        {isDataLoaded && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={handleClearSession}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear Session
          </Button>
        )}
        <p className="px-2 text-xs text-muted-foreground">
          All data stays in your browser
        </p>
      </div>
    </aside>
  )
}
