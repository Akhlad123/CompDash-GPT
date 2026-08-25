import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface KPICardProps {
  icon: LucideIcon
  label: string
  value: string
  delta?: string
  deltaType?: 'positive' | 'negative' | 'neutral'
  className?: string
}

export default function KPICard({
  icon: Icon,
  label,
  value,
  delta,
  deltaType = 'neutral',
  className,
}: KPICardProps) {
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <CardContent className="flex items-start gap-4 pt-6">
        <div className="rounded-lg bg-primary/10 p-2.5">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-bold tracking-tight">
            {value}
          </p>
          {delta && (
            <p
              className={cn(
                'mt-0.5 text-xs font-medium',
                deltaType === 'positive' && 'text-green-600 dark:text-green-400',
                deltaType === 'negative' && 'text-red-600 dark:text-red-400',
                deltaType === 'neutral' && 'text-muted-foreground'
              )}
            >
              {delta}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
