import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export interface ParseResult {
  headers: string[]
  rows: Record<string, string>[]
}

export function parseCSV(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headers = results.meta.fields ?? []
        resolve({ headers, rows: results.data })
      },
      error: (err: Error) => reject(err),
    })
  })
}

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (val instanceof Date) {
    // Format as YYYY-MM-DD HH:mm:ss using local time (no timezone shift)
    const y = val.getFullYear()
    const mo = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    const h = String(val.getHours()).padStart(2, '0')
    const mi = String(val.getMinutes()).padStart(2, '0')
    const s = String(val.getSeconds()).padStart(2, '0')
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`
  }
  return String(val)
}

export async function parseExcel(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) {
    return { headers: [], rows: [] }
  }
  const sheet = workbook.Sheets[sheetName]
  const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd hh:mm:ss',
  })

  if (jsonRows.length === 0) {
    return { headers: [], rows: [] }
  }

  const headers = Object.keys(jsonRows[0])
  const rows = jsonRows.map((row) => {
    const out: Record<string, string> = {}
    for (const key of headers) {
      out[key] = formatCellValue(row[key])
    }
    return out
  })

  return { headers, rows }
}

export function parseFile(file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.tsv')) {
    return parseCSV(file)
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseExcel(file)
  }
  return Promise.reject(new Error(`Unsupported file type: ${file.name}`))
}
