import { jsPDF } from 'jspdf'
import * as XLSX from 'xlsx'

// ── Helpers ──────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

// ── Capture ──────────────────────────────────────────────────────────
// html2canvas v1 is patched via patch-html2canvas.cjs to handle
// oklab()/oklch() colors from Tailwind CSS v4 (returns transparent
// instead of throwing).

async function captureElement(el: HTMLElement): Promise<HTMLCanvasElement> {
  const html2canvas = (await import('html2canvas')).default
  return html2canvas(el, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    logging: false,
    backgroundColor:
      document.documentElement.classList.contains('dark')
        ? '#1a1a2e'
        : '#ffffff',
    onclone: (clonedDoc: Document) => {
      // Copy ECharts canvas pixels into the cloned DOM
      const origCanvases = el.querySelectorAll('canvas')
      const clonedTarget = clonedDoc.getElementById(el.id)
      if (!clonedTarget) return
      const clonedCanvases = clonedTarget.querySelectorAll('canvas')
      origCanvases.forEach((origCanvas, i) => {
        const clonedCanvas = clonedCanvases[i]
        if (!clonedCanvas) return
        try {
          const ctx = clonedCanvas.getContext('2d')
          clonedCanvas.width = origCanvas.width
          clonedCanvas.height = origCanvas.height
          if (ctx) ctx.drawImage(origCanvas, 0, 0)
        } catch { /* tainted canvas — skip */ }
      })
    },
  })
}

// ── PDF ──────────────────────────────────────────────────────────────

export async function exportToPDF(
  elementId: string,
  filename: string
): Promise<void> {
  const el = document.getElementById(elementId)
  if (!el) {
    alert('Export failed: content element not found.')
    return
  }

  try {
    const canvas = await captureElement(el)

    const imgData = canvas.toDataURL('image/png')
    const imgWidth = canvas.width
    const imgHeight = canvas.height

    const pdfWidth = 297
    const pdfHeight = (imgHeight * pdfWidth) / imgWidth

    const pdf = new jsPDF({
      orientation: pdfWidth > pdfHeight ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [pdfWidth, Math.max(pdfHeight, 210)],
    })

    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight)
    pdf.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`)
  } catch (err) {
    console.error('[exportToPDF error]', err)
    alert(`PDF export failed: ${errMsg(err)}`)
  }
}

// ── Excel ────────────────────────────────────────────────────────────

export function exportToExcel(
  data: Record<string, unknown>[],
  filename: string
): void {
  if (!data || data.length === 0) {
    alert('No data available to export. Make sure data is loaded and visible.')
    return
  }

  try {
    const clean = data.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        if (v === null || v === undefined) out[k] = ''
        else if (typeof v === 'bigint') out[k] = Number(v)
        else if (typeof v === 'object') out[k] = JSON.stringify(v)
        else out[k] = v
      }
      return out
    })

    const ws = XLSX.utils.json_to_sheet(clean)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Data')
    XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
  } catch (err) {
    console.error('[exportToExcel error]', err)
    alert('Excel export failed. See browser console for details.')
  }
}

// ── PNG ──────────────────────────────────────────────────────────────

export async function exportToPNG(
  elementId: string,
  filename: string
): Promise<void> {
  const el = document.getElementById(elementId)
  if (!el) {
    alert('Export failed: content element not found.')
    return
  }

  try {
    const canvas = await captureElement(el)

    const link = document.createElement('a')
    link.download = filename.endsWith('.png') ? filename : `${filename}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  } catch (err) {
    console.error('[exportToPNG error]', err)
    alert(`PNG export failed: ${errMsg(err)}`)
  }
}
