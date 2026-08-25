import { Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportToExcel } from '@/lib/exportUtils'

interface ExportExcelProps {
  data: Record<string, unknown>[]
  filename?: string
}

export default function ExportExcel({
  data,
  filename = 'compdash-export',
}: ExportExcelProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => exportToExcel(data, filename)}
      disabled={data.length === 0}
    >
      <Table2 className="mr-1 h-3.5 w-3.5" />
      Excel
    </Button>
  )
}
