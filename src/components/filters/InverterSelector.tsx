import { useCallback } from 'react'
import { Badge } from '@/components/ui/badge'

interface InverterSelectorProps {
  serials: string[]
  selected: string[]
  onChange: (serials: string[]) => void
  maxSelect?: number
}

export default function InverterSelector({
  serials,
  selected,
  onChange,
  maxSelect = 4,
}: InverterSelectorProps) {
  const toggle = useCallback(
    (serial: string) => {
      if (selected.includes(serial)) {
        onChange(selected.filter((s) => s !== serial))
      } else if (selected.length < maxSelect) {
        onChange([...selected, serial])
      }
    },
    [selected, onChange, maxSelect]
  )

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        Select up to {maxSelect} inverters to compare
      </p>
      <div className="flex flex-wrap gap-1.5">
        {serials.map((s) => {
          const active = selected.includes(s)
          return (
            <Badge
              key={s}
              variant={active ? 'default' : 'secondary'}
              className="cursor-pointer select-none font-mono text-xs"
              onClick={() => toggle(s)}
            >
              {s}
            </Badge>
          )
        })}
      </div>
    </div>
  )
}
