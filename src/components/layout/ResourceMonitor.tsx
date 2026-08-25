import { useEffect, useState, useRef } from 'react'
import { Activity, ChevronDown, ChevronUp, Cpu, MemoryStick } from 'lucide-react'

interface MemInfo {
  usedMB: number
  totalMB: number
  limitMB: number
  pct: number
}

interface PerfMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

function BarMini({ pct, danger }: { pct: number; danger: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all ${danger ? 'bg-red-500' : pct > 55 ? 'bg-amber-500' : 'bg-emerald-500'}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  )
}

export default function ResourceMonitor() {
  const [open, setOpen] = useState(false)
  const [mem, setMem] = useState<MemInfo | null>(null)
  const [fps, setFps] = useState<number | null>(null)
  const frameTimesRef = useRef<number[]>([])
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (!open) return
    let active = true
    const tick = (now: number) => {
      if (!active) return
      frameTimesRef.current.push(now)
      frameTimesRef.current = frameTimesRef.current.filter((t) => t > now - 1000)
      setFps(frameTimesRef.current.length)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const read = () => {
      const perf = performance as Performance & { memory?: PerfMemory }
      if (perf.memory) {
        const m = perf.memory
        setMem({
          usedMB: m.usedJSHeapSize / 1048576,
          totalMB: m.totalJSHeapSize / 1048576,
          limitMB: m.jsHeapSizeLimit / 1048576,
          pct: (m.usedJSHeapSize / m.jsHeapSizeLimit) * 100,
        })
      }
    }
    read()
    const id = setInterval(read, 1500)
    return () => clearInterval(id)
  }, [open])

  const fpsColor = !fps ? 'text-muted-foreground'
    : fps < 20 ? 'text-red-500'
    : fps < 45 ? 'text-amber-500'
    : 'text-emerald-500'

  const memDanger = !!mem && mem.pct > 70

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 select-none font-mono text-xs">
      {open ? (
        <div className="w-56 rounded-xl border bg-card/95 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide">
              <Activity className="h-3.5 w-3.5 text-emerald-500" /> Resource Monitor
            </span>
            <button
              onClick={() => setOpen(false)}
              className="rounded p-0.5 hover:bg-muted"
              aria-label="Close"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-3 p-3">
            {/* Memory */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <MemoryStick className="h-3 w-3" /> JS Heap
                </span>
                {mem ? (
                  <span className={memDanger ? 'text-red-500' : mem.pct > 55 ? 'text-amber-500' : 'text-emerald-500'}>
                    {mem.usedMB.toFixed(1)} / {mem.limitMB.toFixed(0)} MB
                  </span>
                ) : (
                  <span className="text-muted-foreground">Chrome only</span>
                )}
              </div>
              {mem && (
                <>
                  <BarMini pct={mem.pct} danger={memDanger} />
                  <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
                    <span>{mem.pct.toFixed(1)}% used</span>
                    <span>alloc {mem.totalMB.toFixed(1)} MB</span>
                  </div>
                </>
              )}
            </div>

            {/* FPS */}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Cpu className="h-3 w-3" /> UI FPS
              </span>
              <span className={fpsColor}>
                {fps !== null ? `${fps} fps` : '…'}
              </span>
            </div>
            {fps !== null && (
              <BarMini pct={(fps / 60) * 100} danger={fps < 20} />
            )}

            {/* Tip */}
            <p className="border-t pt-2 text-[10px] leading-tight text-muted-foreground">
              DuckDB-WASM runs entirely in-browser.
              High heap = large dataset loaded.
              Low FPS = heavy query running.
            </p>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full border bg-card/90 px-3 py-1.5 shadow-md backdrop-blur transition-colors hover:bg-muted/60"
          title="Open resource monitor"
        >
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          <span className="text-[11px]">Resources</span>
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
