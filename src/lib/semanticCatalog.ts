// Semantic catalog: single source of truth for all domain field definitions.
// Used by the intent router to inject schema context into LLM prompts without
// passing raw data rows. No runtime dependencies — pure constants + helpers.

export type FieldTable = 'fleet' | 'telemetry' | 'derived' | 'domain'
export type AggregationType = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'p50' | 'p90' | 'p95' | 'p99'

export interface SemanticField {
  field: string
  label: string
  description: string
  unit: string
  table: FieldTable
  dataType: 'string' | 'number' | 'timestamp' | 'boolean'
  aggregations: AggregationType[]
  synonyms: string[]
  allowedFilters: string[]
  expression?: string
}

// ─── Fleet fields ────────────────────────────────────────────────────────────

export const FLEET_FIELDS: SemanticField[] = [
  {
    field: 'site_id',
    label: 'Site ID',
    description: 'Unique site identifier; join key between fleet and telemetry',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['site', 'location id', 'system id', 'plant id'],
    allowedFilters: ['site_id'],
  },
  {
    field: 'country',
    label: 'Country',
    description: 'Full country name of the installation site',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['nation', 'country name'],
    allowedFilters: ['country', 'tss_region', 'tss_country'],
  },
  {
    field: 'tss_region',
    label: 'TSS Region',
    description: 'TSS region code: NA, EURO, BR, ANZP, LATAM, IN, EMKT',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['region', 'territory', 'tss region', 'sales region', 'geographic region'],
    allowedFilters: ['tss_region'],
  },
  {
    field: 'tss_country',
    label: 'TSS Country',
    description: 'TSS country sub-region (e.g. Belgium, Rest of EURO)',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['sub-region', 'tss country', 'country group'],
    allowedFilters: ['tss_region', 'tss_country'],
  },
  {
    field: 'region_bundle',
    label: 'Region Bundle',
    description: 'Computed geographic bundle for legacy chart grouping',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['bundle region', 'legacy region'],
    allowedFilters: ['region_bundle'],
  },
  {
    field: 'product_type',
    label: 'Product Type',
    description: 'Microinverter SKU family (e.g. IQ9N, IQ8HC, IQ8P)',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['product', 'sku', 'microinverter model', 'inverter type', 'model', 'iq9n', 'iq8hc', 'iq8p'],
    allowedFilters: ['product_type', 'quarter_first_interval', 'tss_region'],
  },
  {
    field: 'device_type_name',
    label: 'Device Type Name',
    description: 'Full device type description',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['device type', 'device name'],
    allowedFilters: ['device_type_name'],
  },
  {
    field: 'pv_module_make',
    label: 'PV Module Make',
    description: 'Solar panel manufacturer name',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['module manufacturer', 'panel make', 'solar panel brand', 'module make', 'panel manufacturer'],
    allowedFilters: ['pv_module_make'],
  },
  {
    field: 'pv_module_model',
    label: 'PV Module Model',
    description: 'Solar panel model name',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['module model', 'panel model'],
    allowedFilters: ['pv_module_model'],
  },
  {
    field: 'module_wafer',
    label: 'Module Wafer',
    description: 'Wafer technology: M6, M10, G12R, G12, No data',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['wafer', 'wafer tech', 'wafer technology', 'cell size', 'wafer size', 'm10', 'm6', 'g12'],
    allowedFilters: ['module_wafer'],
  },
  {
    field: 'stc_rating2',
    label: 'Module STC Rating',
    description: 'PV module STC power rating in Watts',
    unit: 'W',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90'],
    synonyms: ['stc rating', 'module wattage', 'module power', 'panel wattage', 'panel power', 'wattage', 'stc power'],
    allowedFilters: ['tss_region', 'module_wafer', 'product_type', 'quarter_first_interval'],
  },
  {
    field: 'stc_mwdc',
    label: 'STC MWdc',
    description: 'Total DC capacity in megawatts at STC',
    unit: 'MWdc',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['sum', 'avg'],
    synonyms: ['mwdc', 'dc capacity', 'stc mwdc'],
    allowedFilters: ['tss_region', 'quarter_first_interval'],
  },
  {
    field: 'mwac',
    label: 'MWac',
    description: 'Total AC capacity in megawatts',
    unit: 'MWac',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['sum', 'avg'],
    synonyms: ['mwac', 'ac capacity', 'ac megawatts'],
    allowedFilters: ['tss_region', 'quarter_first_interval'],
  },
  {
    field: 'dc_ac_ratio',
    label: 'DC/AC Ratio',
    description: 'Ratio of DC module capacity to AC inverter capacity (oversizing factor)',
    unit: '',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90', 'p95'],
    synonyms: ['dc ac ratio', 'dc/ac', 'oversizing', 'oversizing ratio', 'dc to ac', 'sizing ratio'],
    allowedFilters: ['tss_region', 'product_type', 'module_wafer', 'quarter_first_interval'],
  },
  {
    field: 'unit_count',
    label: 'Unit Count',
    description: 'Number of microinverter units at the site/row',
    unit: 'units',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['sum', 'avg', 'min', 'max'],
    synonyms: ['units', 'microinverters', 'inverter count', 'number of units', 'how many units', 'count'],
    allowedFilters: ['tss_region', 'product_type', 'quarter_first_interval'],
  },
  {
    field: 'power_bucket',
    label: 'Power Bucket',
    description: 'Module power category bucket (e.g. 300-350W, 400-450W)',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['power bucket', 'power range', 'wattage bucket', 'power category'],
    allowedFilters: ['power_bucket'],
  },
  {
    field: 'power_block',
    label: 'Power Block',
    description: 'Broader power grouping block',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['power block'],
    allowedFilters: ['power_block'],
  },
  {
    field: 'quarter_first_interval',
    label: 'Quarter (First Interval)',
    description: 'Quarter in which the site first appeared in fleet data (e.g. "2026 - Q1")',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['quarter', 'q1', 'q2', 'q3', 'q4', 'deployment quarter', 'first quarter', 'fleet quarter'],
    allowedFilters: ['quarter_first_interval'],
  },
  {
    field: 'quarter_device_created',
    label: 'Quarter (Device Created)',
    description: 'Quarter in which the device record was created (secondary date dimension)',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['device created quarter', 'created quarter'],
    allowedFilters: ['quarter_device_created'],
  },
  {
    field: 'city',
    label: 'City',
    description: 'City of the installation',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['city', 'town', 'municipality'],
    allowedFilters: ['city', 'state', 'country'],
  },
  {
    field: 'state',
    label: 'State / Province',
    description: 'State or province of the installation',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['state', 'province', 'region state'],
    allowedFilters: ['state', 'country'],
  },
  {
    field: 'zip_code',
    label: 'ZIP Code',
    description: 'Postal ZIP code of the installation',
    unit: '',
    table: 'fleet',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['zip', 'postal code', 'postcode', 'zip code'],
    allowedFilters: ['zip_code'],
  },
  {
    field: 'latitude',
    label: 'Latitude',
    description: 'Geographic latitude of the site',
    unit: '°',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg'],
    synonyms: ['lat', 'latitude'],
    allowedFilters: [],
  },
  {
    field: 'longitude',
    label: 'Longitude',
    description: 'Geographic longitude of the site',
    unit: '°',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg'],
    synonyms: ['lon', 'long', 'longitude'],
    allowedFilters: [],
  },
  {
    field: 'irr_ann_kwh_m2_month',
    label: 'Irradiance (Monthly)',
    description: 'Precomputed annual-average monthly GHI from NASA POWER at site location (kWh/m²/month)',
    unit: 'kWh/m²/month',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90'],
    synonyms: ['irradiance', 'ghi', 'solar irradiance', 'solar resource', 'irradiation', 'solar exposure', 'insolation'],
    allowedFilters: ['tss_region', 'country'],
  },
  {
    field: 'voc',
    label: 'Open-Circuit Voltage (Voc)',
    description: 'Module open-circuit voltage at STC',
    unit: 'V',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max'],
    synonyms: ['voc', 'open circuit voltage', 'open-circuit voltage'],
    allowedFilters: ['product_type', 'module_wafer'],
  },
  {
    field: 'isc',
    label: 'Short-Circuit Current (Isc)',
    description: 'Module short-circuit current at STC',
    unit: 'A',
    table: 'fleet',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max'],
    synonyms: ['isc', 'short circuit current', 'short-circuit current'],
    allowedFilters: ['product_type', 'module_wafer'],
  },
]

// ─── Telemetry fields ─────────────────────────────────────────────────────────

export const TELEMETRY_FIELDS: SemanticField[] = [
  {
    field: 'serial_number',
    label: 'Serial Number',
    description: '12-digit microinverter serial number (primary inverter identifier)',
    unit: '',
    table: 'telemetry',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['serial', 'sn', 'inverter id', 'microinverter id', 'device id', 'inverter serial'],
    allowedFilters: ['serial_number', 'site_id'],
  },
  {
    field: 'site_id',
    label: 'Site ID',
    description: 'Site identifier (join key to fleet)',
    unit: '',
    table: 'telemetry',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['site', 'location', 'system id'],
    allowedFilters: ['site_id'],
  },
  {
    field: 'timestamp',
    label: 'Timestamp',
    description: 'Local reading timestamp (5 or 15-min granularity)',
    unit: '',
    table: 'telemetry',
    dataType: 'timestamp',
    aggregations: ['min', 'max', 'count'],
    synonyms: ['time', 'datetime', 'reading time', 'interval time'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'local_date',
    label: 'Local Date',
    description: 'Date of reading (YYYY-MM-DD)',
    unit: '',
    table: 'telemetry',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['date', 'reading date', 'day'],
    allowedFilters: ['site_id'],
  },
  {
    field: 'ac_voltage',
    label: 'AC Voltage',
    description: 'Inverter AC output voltage',
    unit: 'V',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90', 'p95'],
    synonyms: ['ac voltage', 'output voltage', 'grid voltage', 'vac'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'ac_frequency',
    label: 'AC Frequency',
    description: 'Grid AC frequency',
    unit: 'Hz',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max'],
    synonyms: ['frequency', 'grid frequency', 'ac frequency', 'hz'],
    allowedFilters: ['site_id'],
  },
  {
    field: 'temperature_f',
    label: 'Temperature (°F)',
    description: 'Inverter/cell temperature in degrees Fahrenheit',
    unit: '°F',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90', 'p95'],
    synonyms: ['temperature', 'temp', 'inverter temperature', 'cell temperature', 'fahrenheit'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'dc_current',
    label: 'DC Current',
    description: 'DC input current from PV module',
    unit: 'A',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90', 'p95'],
    synonyms: ['dc current', 'idc', 'current', 'input current'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'dc_voltage',
    label: 'DC Voltage',
    description: 'DC input voltage from PV module',
    unit: 'V',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90'],
    synonyms: ['dc voltage', 'vdc', 'panel voltage', 'input voltage'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'duration',
    label: 'Duration',
    description: 'Reporting interval length in seconds',
    unit: 's',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['avg', 'sum'],
    synonyms: ['duration', 'interval', 'seconds', 'reporting period'],
    allowedFilters: ['site_id'],
  },
  {
    field: 'energy_produced',
    label: 'Energy Produced',
    description: 'Energy produced during the reporting interval',
    unit: 'Wh',
    table: 'telemetry',
    dataType: 'number',
    aggregations: ['sum', 'avg', 'min', 'max', 'p50', 'p90'],
    synonyms: ['energy', 'wh', 'energy produced', 'production', 'yield', 'output', 'generation', 'kwh'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'sku_name',
    label: 'SKU Name',
    description: 'Microinverter model name from telemetry (optional)',
    unit: '',
    table: 'telemetry',
    dataType: 'string',
    aggregations: ['count'],
    synonyms: ['sku', 'model', 'product', 'inverter model', 'model name'],
    allowedFilters: ['sku_name', 'site_id'],
  },
]

// ─── Derived fields (calculated at query time, never stored) ──────────────────

export const DERIVED_FIELDS: SemanticField[] = [
  {
    field: 'dc_power',
    label: 'DC Power',
    description: 'Instantaneous DC power: dc_current × dc_voltage',
    unit: 'W',
    table: 'derived',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90', 'p95'],
    synonyms: ['dc power', 'input power', 'panel power', 'pv power'],
    allowedFilters: ['site_id', 'serial_number'],
    expression: 'dc_current * dc_voltage',
  },
  {
    field: 'ac_power',
    label: 'AC Power',
    description: 'Instantaneous AC output power: energy_produced × 3600 / duration',
    unit: 'W',
    table: 'derived',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90', 'p95'],
    synonyms: ['ac power', 'output power', 'power output', 'power produced'],
    allowedFilters: ['site_id', 'serial_number'],
    expression: '(energy_produced * 3600.0 / NULLIF(duration, 0))',
  },
  {
    field: 'temperature_c',
    label: 'Temperature (°C)',
    description: 'Inverter temperature converted to Celsius: (temperature_f - 32) × 5/9',
    unit: '°C',
    table: 'derived',
    dataType: 'number',
    aggregations: ['avg', 'min', 'max', 'p50', 'p90'],
    synonyms: ['celsius', 'temperature celsius', 'temp c', 'degrees c'],
    allowedFilters: ['site_id', 'serial_number'],
    expression: '((temperature_f - 32) * 5.0 / 9.0)',
  },
]

// ─── Domain concept fields ────────────────────────────────────────────────────

export const DOMAIN_FIELDS: SemanticField[] = [
  {
    field: 'clipping_duration',
    label: 'Clipping Duration',
    description: 'Hours during which the inverter operated at its AC power or DC current limit (flat-run detection)',
    unit: 'h',
    table: 'domain',
    dataType: 'number',
    aggregations: ['sum', 'avg', 'max'],
    synonyms: ['clipping', 'clipping hours', 'clipping duration', 'power clipping', 'current clipping', 'limiting'],
    allowedFilters: ['site_id', 'serial_number', 'sku_name'],
  },
  {
    field: 'clipping_energy',
    label: 'Clipping Energy Loss',
    description: 'Estimated energy lost to clipping during flat runs (Wh)',
    unit: 'Wh',
    table: 'domain',
    dataType: 'number',
    aggregations: ['sum', 'avg'],
    synonyms: ['energy lost to clipping', 'clipping loss', 'clipped energy'],
    allowedFilters: ['site_id', 'serial_number'],
  },
  {
    field: 'inverter_utilization',
    label: 'Inverter Utilization',
    description: 'AC power output as a fraction of rated AC capacity: ac_power / rated_ac_power_w',
    unit: '%',
    table: 'domain',
    dataType: 'number',
    aggregations: ['avg', 'p50', 'p90', 'p95', 'p99'],
    synonyms: ['utilization', 'inverter utilization', 'loading', 'ac loading', 'capacity utilization', 'operating point'],
    allowedFilters: ['site_id', 'serial_number', 'sku_name'],
  },
  {
    field: 'z_score',
    label: 'Z-Score (Anomaly)',
    description: 'Standard deviation distance from site mean energy (anomaly detection signal)',
    unit: 'σ',
    table: 'domain',
    dataType: 'number',
    aggregations: ['avg', 'max'],
    synonyms: ['z score', 'anomaly score', 'outlier score', 'standard deviation', 'underperformance score'],
    allowedFilters: ['site_id'],
  },
  {
    field: 'performance_ratio',
    label: 'Performance Ratio',
    description: 'Energy yield relative to irradiance-weighted expected yield (PR)',
    unit: '%',
    table: 'domain',
    dataType: 'number',
    aggregations: ['avg', 'p50', 'p90'],
    synonyms: ['pr', 'performance ratio', 'system efficiency', 'yield ratio'],
    allowedFilters: ['site_id'],
  },
]

// ─── Microinverter rated AC power lookup ──────────────────────────────────────
// Imported from clippingAnalysis.ts to keep this catalog self-contained.
// Values are nominal public-spec approximations (W).

export const SKU_RATED_AC_POWER_W: Record<string, number> = {
  IQ7: 240,
  'IQ7+': 249,
  IQ7X: 290,
  IQ7A: 349,
  IQ7HS: 349,
  IQ7AM: 349,
  IQ7XS: 290,
  IQ7PD: 295,
  IQ7AS: 296,
  IQ8: 240,
  IQ8PLUS: 300,
  'IQ8+': 300,
  IQ8M: 290,
  IQ8MC: 330,
  IQ8H: 349,
  IQ8HC: 384,
  IQ8P: 480,
  'IQ8P-3P': 480,
  IQ8X: 349,
  IQ8D: 366,
  IQ8AC: 366,
  'IQ8H-3P': 349,
  IQ9N: 427,
  'IQ9N-3P-277': 427,
}

/** Resolves rated AC power (W) for a given SKU name via exact then prefix match. */
export function resolveRatedAcPower(sku: string | null | undefined): number | null {
  if (!sku) return null
  const norm = sku.trim().toUpperCase()
  if (SKU_RATED_AC_POWER_W[norm] != null) return SKU_RATED_AC_POWER_W[norm]
  const sorted = Object.keys(SKU_RATED_AC_POWER_W).sort((a, b) => b.length - a.length)
  for (const key of sorted) {
    if (norm.startsWith(key)) return SKU_RATED_AC_POWER_W[key]
  }
  return null
}

// ─── Master catalog ───────────────────────────────────────────────────────────

export const ALL_FIELDS: SemanticField[] = [
  ...FLEET_FIELDS,
  ...TELEMETRY_FIELDS,
  ...DERIVED_FIELDS,
  ...DOMAIN_FIELDS,
]

export const SEMANTIC_CATALOG: Map<string, SemanticField> = new Map(
  ALL_FIELDS.map((f) => [f.field, f])
)

// ─── Synonym lookup ───────────────────────────────────────────────────────────

/**
 * Returns all SemanticFields whose synonyms contain the user term (case-insensitive
 * word-overlap). Used during intent parsing to map user vocabulary to canonical fields.
 */
export function getSynonymMatches(userTerm: string): SemanticField[] {
  const term = userTerm.toLowerCase().trim()
  const results: SemanticField[] = []
  for (const field of ALL_FIELDS) {
    const hit =
      field.field.toLowerCase().includes(term) ||
      field.label.toLowerCase().includes(term) ||
      field.synonyms.some(
        (s) => s.toLowerCase().includes(term) || term.includes(s.toLowerCase())
      )
    if (hit) results.push(field)
  }
  return results
}

// ─── LLM prompt injection helper ─────────────────────────────────────────────

/**
 * Builds a compact, human-readable field list for injection into the Stage 1
 * Analyst LLM system prompt. Keeps token count low — no raw data, no values.
 */
export function buildLLMFieldList(
  table: 'fleet' | 'telemetry' | 'both' | 'all'
): string {
  const includedTables: FieldTable[] = table === 'fleet'
    ? ['fleet']
    : table === 'telemetry'
    ? ['telemetry', 'derived']
    : ['fleet', 'telemetry', 'derived', 'domain']

  const lines: string[] = []

  for (const t of includedTables) {
    const fields = ALL_FIELDS.filter((f) => f.table === t)
    if (fields.length === 0) continue
    const label = t === 'fleet' ? 'FLEET TABLE (fleet)' :
                  t === 'telemetry' ? 'TELEMETRY TABLE (telemetry)' :
                  t === 'derived' ? 'DERIVED COLUMNS (calculated at query time)' :
                  'DOMAIN CONCEPTS'
    lines.push(`\n${label}:`)
    for (const f of fields) {
      const aggStr = f.aggregations.length > 0 ? ` [agg: ${f.aggregations.join(',')}]` : ''
      const unitStr = f.unit ? ` (${f.unit})` : ''
      const synStr = f.synonyms.slice(0, 3).join(', ')
      const exprStr = f.expression ? ` = ${f.expression}` : ''
      lines.push(`  ${f.field}${unitStr}${exprStr}${aggStr} — ${f.description}. Also called: ${synStr}`)
    }
  }

  return lines.join('\n')
}
