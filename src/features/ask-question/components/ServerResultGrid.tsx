import { useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community'

ModuleRegistry.registerModules([AllCommunityModule])

interface ServerResultGridProps {
  rows: Record<string, unknown>[]
}

const theme = themeQuartz.withParams({ accentColor: 'hsl(var(--primary))' })

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  return String(value)
}

export function ServerResultGrid({ rows }: ServerResultGridProps) {
  const columnDefs = useMemo<ColDef<Record<string, unknown>>[]>(() => {
    const keys = rows.length > 0 ? Object.keys(rows[0]) : []
    return keys.map((key) => ({
      field: key,
      headerName: key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      flex: 1,
      minWidth: 150,
      valueFormatter: ({ value }) => formatCell(value),
    }))
  }, [rows])

  return (
    <div className="h-80 overflow-hidden rounded-md border">
      <AgGridReact<Record<string, unknown>>
        theme={theme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        pagination
        paginationPageSize={25}
        suppressCellFocus
      />
    </div>
  )
}
