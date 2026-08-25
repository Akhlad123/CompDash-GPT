// Shared SQL validation for NL-query-generated SQL (rule-based AND LLM
// fallback). Per CompDashGPT.windsurfrules.txt: LLM-generated SQL MUST be
// validated against a table allowlist and must be SELECT-only before
// execution. Applied defensively to rule-based SQL too.

const ALLOWED_TABLES = ['fleet', 'telemetry']
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
  'attach', 'detach', 'copy', 'export', 'import', 'pragma', 'call',
  'grant', 'revoke', 'replace', 'merge', 'vacuum', 'load',
]

export interface SqlValidationResult {
  valid: boolean
  reason?: string
}

/** Validates that SQL is a single SELECT statement referencing only allowed tables. */
export function validateFleetSql(sql: string): SqlValidationResult {
  const trimmed = sql.trim().replace(/;\s*$/, '')

  if (!/^select\b/i.test(trimmed)) {
    return { valid: false, reason: 'Only SELECT statements are allowed.' }
  }

  if (trimmed.includes(';')) {
    return { valid: false, reason: 'Multiple statements are not allowed.' }
  }

  const lower = trimmed.toLowerCase()
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(lower)) {
      return { valid: false, reason: `Forbidden keyword detected: ${kw}` }
    }
  }

  // Strip EXTRACT(... FROM col), CAST(... AS type), and DATE_TRUNC patterns
  // so their FROM/AS tokens don't get misdetected as table references.
  const sanitized = trimmed
    .replace(/\bextract\s*\([^)]*\bfrom\b[^)]*\)/gi, '')
    .replace(/\bcast\s*\([^)]*\)/gi, '')
    .replace(/\bdate_trunc\s*\([^)]*\)/gi, '')

  const fromMatches = [...sanitized.matchAll(/\bfrom\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)]
  const joinMatches = [...sanitized.matchAll(/\bjoin\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)]
  const referencedTables = [...fromMatches, ...joinMatches].map((m) => m[1].toLowerCase())

  if (referencedTables.length === 0) {
    return { valid: false, reason: 'No table reference found.' }
  }

  for (const table of referencedTables) {
    if (!ALLOWED_TABLES.includes(table)) {
      return { valid: false, reason: `Table not allowed: ${table}` }
    }
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// SQL auto-fixer — GROUP BY mismatch
// ---------------------------------------------------------------------------

const AGG_PATTERN = /\b(?:SUM|COUNT|AVG|MIN|MAX|PERCENTILE_CONT|PERCENTILE_DISC|MEDIAN|STDDEV|VARIANCE|STRING_AGG|LISTAGG|ANY_VALUE|FIRST|LAST)\s*\(/i

/** Splits a comma-separated SQL expression list respecting parenthesis depth. */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** Returns plain column names from a SELECT list, excluding aggregate expressions and wildcards. */
function nonAggregateCols(selectList: string): string[] {
  return splitTopLevelCommas(selectList)
    .filter((expr) => !AGG_PATTERN.test(expr) && !expr.includes('*'))
    .map((expr) => expr.replace(/\s+AS\s+\w+\s*$/i, '').trim())
    .filter((col) => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(col))
}

/**
 * Attempts to fix common GROUP BY errors in LLM-generated SQL before execution.
 * Handles two patterns observed in the wild:
 *   1. Aggregate + non-aggregate SELECT cols but NO GROUP BY → injects GROUP BY
 *   2. GROUP BY present but ORDER BY references bare cols not in GROUP BY → adds them
 * Returns the (possibly corrected) SQL. Does not throw.
 */
export function fixSqlGroupBy(sql: string): string {
  try {
    const trimmed = sql.trim()
    if (!/^SELECT\b/i.test(trimmed) || !AGG_PATTERN.test(trimmed)) return sql

    let fixed = trimmed

    // ── Phase 0: strip aggregates from GROUP BY (common LLM mistake) ──────
    const gbMatch0 = fixed.match(/\bGROUP\s+BY\s+([\s\S]+?)(?=\s+(?:ORDER|LIMIT|HAVING|$))/i)
    if (gbMatch0) {
      const gbItems = splitTopLevelCommas(gbMatch0[1])
      const clean = gbItems.filter((item) => !AGG_PATTERN.test(item))
      if (clean.length < gbItems.length) {
        if (clean.length > 0) {
          fixed = fixed.replace(gbMatch0[0], `GROUP BY ${clean.join(', ')}`)
        } else {
          // All GROUP BY entries were aggregates — remove the clause entirely
          fixed = fixed.replace(/\bGROUP\s+BY\s+[\s\S]+?(?=\s+(?:ORDER|LIMIT|HAVING|$))/i, '')
        }
      }
    }

    // ── Phase 1: inject missing GROUP BY ────────────────────────────────────
    if (!/\bGROUP\s+BY\b/i.test(fixed)) {
      const selectM = fixed.match(/^SELECT\s+([\s\S]+?)\s+FROM\s/i)
      if (selectM) {
        const cols = nonAggregateCols(selectM[1])
        if (cols.length > 0) {
          const gbClause = `GROUP BY ${cols.join(', ')}`
          // Insert before ORDER BY or LIMIT; append otherwise
          if (/\b(ORDER\s+BY|LIMIT)\b/i.test(fixed)) {
            fixed = fixed.replace(/\b(ORDER\s+BY|LIMIT)\b/i, `${gbClause} $1`)
          } else {
            fixed = `${fixed} ${gbClause}`
          }
        }
      }
    }

    // ── Phase 2: add ORDER BY cols missing from GROUP BY ────────────────────
    const gbM = fixed.match(/\bGROUP\s+BY\s+([\s\S]+?)(?=\s+(?:ORDER|LIMIT|HAVING|$))/i)
    const obM = fixed.match(/\bORDER\s+BY\s+([\s\S]+?)(?=\s+(?:LIMIT|$))/i)
    if (gbM && obM) {
      const gbCols = splitTopLevelCommas(gbM[1]).map((c) => c.trim().toLowerCase())
      const missing = splitTopLevelCommas(obM[1])
        .map((part) => part.replace(/\s+(?:ASC|DESC)\s*$/i, '').trim())
        .filter((col) => !AGG_PATTERN.test(col) && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(col) && !gbCols.includes(col.toLowerCase()))
      if (missing.length > 0) {
        fixed = fixed.replace(gbM[0], `${gbM[0].trimEnd()}, ${missing.join(', ')}`)
      }
    }

    return fixed
  } catch {
    return sql // never break execution on fixer failure
  }
}
