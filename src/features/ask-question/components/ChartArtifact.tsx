import Plot from 'react-plotly.js'

interface ChartArtifactProps {
  specification: Record<string, unknown>
  accessibleSummary: string
}

export function ChartArtifact({ specification, accessibleSummary }: ChartArtifactProps) {
  const data = Array.isArray(specification.data) ? specification.data : []
  const layout = typeof specification.layout === 'object' && specification.layout !== null ? specification.layout : {}

  return (
    <div className="space-y-2">
      <Plot
        data={data as Plotly.Data[]}
        layout={{ ...layout, autosize: true, margin: { l: 48, r: 24, t: 36, b: 48 } } as Partial<Plotly.Layout>}
        config={{ displaylogo: false, responsive: true }}
        className="w-full"
        useResizeHandler
      />
      <p className="sr-only">{accessibleSummary}</p>
    </div>
  )
}
