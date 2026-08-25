import { StrictMode, useEffect, Component, type ReactNode, type ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import PageWrapper from '@/components/layout/PageWrapper'
import ModeSelectPage from '@/pages/ModeSelectPage'
import UploadPage from '@/pages/UploadPage'
import DataUploadPage from '@/pages/DataUploadPage'
import OverviewPage from '@/pages/OverviewPage'
import SiteComparisonPage from '@/pages/SiteComparisonPage'
import InverterDrilldownPage from '@/pages/InverterDrilldownPage'
import AnomalyPage from '@/pages/AnomalyPage'
import ClippingAnalysisPage from '@/pages/ClippingAnalysisPage'
import DeveloperPage from '@/pages/DeveloperPage'
import BucketAnalysisPage from '@/pages/BucketAnalysisPage'
import FleetOverviewPage from '@/pages/FleetOverviewPage'
import FleetWaferDetailPage from '@/pages/FleetWaferDetailPage'
import FleetProductBucketPage from '@/pages/FleetProductBucketPage'
import FleetChartReplicaPage from '@/pages/FleetChartReplicaPage'
import FleetTransitionPage from '@/pages/FleetTransitionPage'
import FleetDataGate from '@/components/FleetDataGate'
import FleetCompliancePage from '@/pages/FleetCompliancePage'
import QueryPage from '@/pages/QueryPage'
import { applyStateFromURL } from '@/lib/shareLink'
import './index.css'

// Apply dark mode class before first paint
;(() => {
  const stored = localStorage.getItem('compdash_theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  if (stored === 'dark' || (!stored && prefersDark)) {
    document.documentElement.classList.add('dark')
  }
})()

class GlobalErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; errorInfo: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null, errorInfo: '' }
  }
  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[GlobalErrorBoundary]', error, info.componentStack)
    this.setState({ errorInfo: info.componentStack ?? '' })
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif' }}>
          <h1 style={{ color: '#dc2626', fontSize: 24, marginBottom: 16 }}>
            Something went wrong
          </h1>
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fca5a5',
              borderRadius: 8,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <p style={{ fontWeight: 600, marginBottom: 8 }}>
              {this.state.error.message}
            </p>
            <pre
              style={{
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                maxHeight: 200,
                overflow: 'auto',
                opacity: 0.7,
              }}
            >
              {this.state.error.stack}
            </pre>
          </div>
          {this.state.errorInfo && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 14, marginBottom: 8 }}>
                Component Stack
              </summary>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', opacity: 0.6 }}>
                {this.state.errorInfo}
              </pre>
            </details>
          )}
          <button
            onClick={() => {
              this.setState({ error: null, errorInfo: '' })
              window.location.hash = '#/'
              window.location.reload()
            }}
            style={{
              marginTop: 16,
              padding: '8px 16px',
              background: '#2563eb',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Reload App
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, throwOnError: false } },
})

function AppInit() {
  useEffect(() => {
    applyStateFromURL()
  }, [])
  return null
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <HashRouter>
            <AppInit />
            <Routes>
              <Route path="/" element={<ModeSelectPage />} />
              <Route element={<PageWrapper />}>
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/data" element={<DataUploadPage />} />
                <Route path="/overview" element={<OverviewPage />} />
                <Route path="/sites" element={<SiteComparisonPage />} />
                <Route path="/inverters" element={<InverterDrilldownPage />} />
                <Route path="/anomaly" element={<AnomalyPage />} />
                <Route path="/clipping" element={<ClippingAnalysisPage />} />
                <Route path="/buckets" element={<BucketAnalysisPage />} />
                <Route path="/developer" element={<DeveloperPage />} />
                <Route element={<FleetDataGate />}>
                  <Route path="/fleet" element={<FleetOverviewPage />} />
                  <Route path="/fleet/wafer" element={<FleetWaferDetailPage />} />
                  <Route path="/fleet/products" element={<FleetProductBucketPage />} />
                  <Route path="/fleet/chart" element={<FleetChartReplicaPage />} />
                  <Route path="/fleet/transition" element={<FleetTransitionPage />} />
                  <Route path="/fleet/compliance" element={<FleetCompliancePage />} />
                  <Route path="/fleet/query" element={<QueryPage />} />
                </Route>
              </Route>
            </Routes>
          </HashRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </GlobalErrorBoundary>
  </StrictMode>,
)
