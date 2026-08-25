import { useState, useCallback } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportToPDF } from '@/lib/exportUtils'

interface ExportPDFProps {
  elementId: string
  filename?: string
}

export default function ExportPDF({
  elementId,
  filename = 'compdash-export',
}: ExportPDFProps) {
  const [exporting, setExporting] = useState(false)

  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      await exportToPDF(elementId, filename)
    } finally {
      setExporting(false)
    }
  }, [elementId, filename])

  return (
    <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
      {exporting ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : (
        <FileText className="mr-1 h-3.5 w-3.5" />
      )}
      PDF
    </Button>
  )
}
