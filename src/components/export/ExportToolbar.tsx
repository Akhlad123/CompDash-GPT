import { useState, useCallback } from 'react'
import { Image, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportToPNG } from '@/lib/exportUtils'
import ShareLinkButton from './ShareLinkButton'
import ExportPDF from './ExportPDF'
import ExportExcel from './ExportExcel'

interface ExportToolbarProps {
  elementId: string
  filename?: string
  data?: Record<string, unknown>[]
}

export default function ExportToolbar({
  elementId,
  filename = 'compdash-export',
  data = [],
}: ExportToolbarProps) {
  const [pngExporting, setPngExporting] = useState(false)

  const handlePNG = useCallback(async () => {
    setPngExporting(true)
    try {
      await exportToPNG(elementId, filename)
    } finally {
      setPngExporting(false)
    }
  }, [elementId, filename])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ShareLinkButton />
      <ExportPDF elementId={elementId} filename={filename} />
      <ExportExcel data={data} filename={filename} />
      <Button variant="outline" size="sm" onClick={handlePNG} disabled={pngExporting}>
        {pngExporting ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Image className="mr-1 h-3.5 w-3.5" />
        )}
        PNG
      </Button>
    </div>
  )
}
