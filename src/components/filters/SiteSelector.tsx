import { useCallback } from 'react'
import { CheckSquare, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface SiteSelectorProps {
  allSites: string[]
  selectedSites: string[]
  onChange: (sites: string[]) => void
}

export default function SiteSelector({
  allSites,
  selectedSites,
  onChange,
}: SiteSelectorProps) {
  const allSelected = selectedSites.length === allSites.length

  const toggleSite = useCallback(
    (siteId: string) => {
      if (selectedSites.includes(siteId)) {
        const next = selectedSites.filter((s) => s !== siteId)
        if (next.length > 0) onChange(next)
      } else {
        onChange([...selectedSites, siteId])
      }
    },
    [selectedSites, onChange]
  )

  const toggleAll = useCallback(() => {
    if (allSelected) {
      onChange([allSites[0]])
    } else {
      onChange([...allSites])
    }
  }, [allSites, allSelected, onChange])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="xs" onClick={toggleAll}>
          {allSelected ? (
            <CheckSquare className="mr-1 h-3.5 w-3.5" />
          ) : (
            <Square className="mr-1 h-3.5 w-3.5" />
          )}
          {allSelected ? 'Deselect All' : 'Select All'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {selectedSites.length} of {allSites.length} sites
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {allSites.map((site) => {
          const selected = selectedSites.includes(site)
          return (
            <Badge
              key={site}
              variant={selected ? 'default' : 'secondary'}
              className="cursor-pointer select-none"
              onClick={() => toggleSite(site)}
            >
              {site}
            </Badge>
          )
        })}
      </div>
    </div>
  )
}
