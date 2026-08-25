export const STORAGE_KEY = 'compdash_column_mapping'

export interface TelemetryRow {
  serial_number: string
  site_id: string
  timestamp: string
  local_date: string | null
  ac_voltage: number | null
  ac_frequency: number | null
  temperature_f: number | null
  dc_current: number | null
  dc_voltage: number | null
  duration: number | null
  energy_produced: number | null
  sku_name: string | null
}

export interface FieldDescriptor {
  key: string
  label: string
  description: string
  aliases: string[]
}

export const REQUIRED_FIELDS: FieldDescriptor[] = [
  {
    key: 'serial_number',
    label: 'Serial Number',
    description: '12-digit microinverter ID',
    aliases: ['serial', 'serialno', 'serialnum', 'serialnumber', 'microinverterid', 'inverterid', 'sn'],
  },
  {
    key: 'site_id',
    label: 'Site ID',
    description: 'Site identifier',
    aliases: ['site', 'siteid', 'systemid', 'plantid', 'location'],
  },
  {
    key: 'timestamp',
    label: 'Timestamp',
    description: 'Local time (5 or 15-min granularity)',
    aliases: ['timestamp', 'datetime', 'time', 'localtimestamp', 'localtime', 'readingtime'],
  },
  {
    key: 'ac_voltage',
    label: 'AC Voltage',
    description: 'Volts',
    aliases: ['acvoltage', 'acvolt', 'acv', 'vac'],
  },
  {
    key: 'ac_frequency',
    label: 'AC Frequency',
    description: 'Hz',
    aliases: ['acfrequency', 'acfreq', 'frequency', 'freq', 'hz'],
  },
  {
    key: 'temperature_f',
    label: 'Temperature (F)',
    description: 'Degrees Fahrenheit',
    aliases: ['temperature', 'temp', 'temperaturef', 'tempf', 'temperaturefahrenheit'],
  },
  {
    key: 'dc_current',
    label: 'DC Current',
    description: 'Amps',
    aliases: ['dccurrent', 'dci', 'idc', 'currentdc'],
  },
  {
    key: 'dc_voltage',
    label: 'DC Voltage',
    description: 'Volts',
    aliases: ['dcvoltage', 'dcvolt', 'dcv', 'vdc', 'voltagedc'],
  },
  {
    key: 'duration',
    label: 'Duration',
    description: 'Seconds',
    aliases: ['duration', 'dur', 'seconds', 'intervalseconds', 'period'],
  },
  {
    key: 'energy_produced',
    label: 'Energy Produced',
    description: 'Wh',
    aliases: ['energyproduced', 'energy', 'energywh', 'wh', 'yield', 'production'],
  },
]

const OPTIONAL_FIELDS: FieldDescriptor[] = [
  {
    key: 'sku_name',
    label: 'SKU / Model Name',
    description: 'Optional model name',
    aliases: ['sku', 'skuname', 'model', 'modelname', 'productname', 'invertermodel'],
  },
  {
    key: 'local_date',
    label: 'Local Date',
    description: 'Date of reading (YYYY-MM-DD)',
    aliases: ['localdate', 'date', 'readingdate', 'reportdate', 'reportingdate'],
  },
]

export const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function fuzzyMatch(csvHeaders: string[], field: string): string | null {
  const descriptor = ALL_FIELDS.find((f) => f.key === field)
  if (!descriptor) return null

  const normalizedHeaders = csvHeaders.map((h) => ({ original: h, norm: normalize(h) }))

  // Exact alias match first
  for (const alias of descriptor.aliases) {
    const match = normalizedHeaders.find((h) => h.norm === alias)
    if (match) return match.original
  }

  // Partial match: header contains alias or alias contains header
  for (const alias of descriptor.aliases) {
    const match = normalizedHeaders.find(
      (h) => h.norm.includes(alias) || alias.includes(h.norm)
    )
    if (match) return match.original
  }

  return null
}

export function buildAutoMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  const usedHeaders = new Set<string>()

  for (const field of ALL_FIELDS) {
    const match = fuzzyMatch(
      headers.filter((h) => !usedHeaders.has(h)),
      field.key
    )
    if (match) {
      mapping[field.key] = match
      usedHeaders.add(match)
    }
  }

  return mapping
}

export function saveMapping(mapping: Record<string, string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mapping))
}

export function loadMapping(): Record<string, string> | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return null
  }
}

function toNumber(val: string): number | null {
  if (val === '' || val === undefined || val === null) return null
  const num = Number(val)
  return Number.isNaN(num) ? null : num
}

export interface ValidationWarning {
  row: number
  field: string
  message: string
}

export function applyMapping(
  rows: Record<string, string>[],
  mapping: Record<string, string>
): { data: TelemetryRow[]; warnings: ValidationWarning[] } {
  const result: TelemetryRow[] = []
  const warnings: ValidationWarning[] = []

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]

    const serialRaw = mapping['serial_number'] ? (raw[mapping['serial_number']] ?? '') : ''
    const serial = serialRaw.replace(/\s/g, '')

    if (serial.length !== 12) {
      warnings.push({
        row: i + 1,
        field: 'serial_number',
        message: `Serial number "${serial}" is not exactly 12 characters (got ${serial.length})`,
      })
    }

    const siteId = mapping['site_id'] ? (raw[mapping['site_id']] ?? '') : ''
    const timestamp = mapping['timestamp'] ? (raw[mapping['timestamp']] ?? '') : ''

    if (!timestamp) {
      warnings.push({ row: i + 1, field: 'timestamp', message: 'Empty timestamp' })
    }

    const numericFields = [
      'ac_voltage', 'ac_frequency', 'temperature_f',
      'dc_current', 'dc_voltage', 'duration', 'energy_produced',
    ] as const

    const numValues: Record<string, number | null> = {}
    for (const f of numericFields) {
      const csvCol = mapping[f]
      const rawVal = csvCol ? (raw[csvCol] ?? '') : ''
      const num = toNumber(rawVal)
      if (rawVal !== '' && num === null) {
        warnings.push({
          row: i + 1,
          field: f,
          message: `Non-numeric value "${rawVal}"`,
        })
      }
      numValues[f] = num
    }

    const skuCol = mapping['sku_name']
    const skuName = skuCol ? (raw[skuCol] || null) : null

    const localDateCol = mapping['local_date']
    const localDate = localDateCol ? (raw[localDateCol] || null) : null

    result.push({
      serial_number: serial,
      site_id: siteId,
      timestamp,
      local_date: localDate,
      ac_voltage: numValues['ac_voltage'] ?? null,
      ac_frequency: numValues['ac_frequency'] ?? null,
      temperature_f: numValues['temperature_f'] ?? null,
      dc_current: numValues['dc_current'] ?? null,
      dc_voltage: numValues['dc_voltage'] ?? null,
      duration: numValues['duration'] ?? null,
      energy_produced: numValues['energy_produced'] ?? null,
      sku_name: skuName,
    })
  }

  return { data: result, warnings }
}
