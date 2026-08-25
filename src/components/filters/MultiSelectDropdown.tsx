import { useMemo, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

interface MultiSelectDropdownProps {
  label: string
  options: string[]
  selected: string[]
  onChange: (values: string[]) => void
  /** When true (default), an empty `selected` array is treated as "All selected". */
  emptyMeansAll?: boolean
  className?: string
  disabled?: boolean
  /** Optional formatter for display-only labels (e.g. raw code -> friendly name). Filtering/selection still uses the raw option value. */
  formatLabel?: (value: string) => string
}

/**
 * Searchable multi-select dropdown backed by checkboxes. Used for filters
 * with many options (e.g. Country) where inline badges would be unwieldy.
 * By default, an empty selection is treated as "All" (no filtering applied).
 */
export default function MultiSelectDropdown({
  label, options, selected, onChange, emptyMeansAll = true, className, disabled, formatLabel,
}: MultiSelectDropdownProps) {
  const display = (v: string) => formatLabel?.(v) ?? v
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options
    const q = search.toLowerCase()
    return options.filter((o) => o.toLowerCase().includes(q) || display(o).toLowerCase().includes(q))
  }, [options, search]) // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = emptyMeansAll && selected.length === 0
  const summary = allSelected
    ? 'All'
    : selected.length === 1
      ? display(selected[0])
      : `${selected.length} selected`

  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((s) => s !== v))
    else onChange([...selected, v])
  }

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-sm font-medium">{label}:</span>
        {selected.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onChange([])}
            className="h-5 px-1.5 text-xs text-muted-foreground"
          >
            <X className="mr-1 h-3 w-3" /> Clear
          </Button>
        )}
      </div>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" disabled={disabled} className="min-w-40 justify-between" />
          }
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 w-64">
          {options.length > 8 && (
            <div className="sticky top-0 z-10 bg-popover p-1">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className="h-7 pl-7 text-xs"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
              <DropdownMenuSeparator />
            </div>
          )}
          {filteredOptions.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">No matches</div>
          ) : (
            filteredOptions.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt}
                checked={allSelected || selected.includes(opt)}
                onCheckedChange={() => toggle(opt)}
                onClick={(e) => e.preventDefault()}
              >
                {display(opt)}
              </DropdownMenuCheckboxItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
