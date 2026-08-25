import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

function getInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem('compdash_theme')
  if (stored === 'dark' || stored === 'light') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('compdash_theme', theme)
  }, [theme])

  return (
    <Button
      variant="ghost"
      size="sm"
      className="w-full justify-start gap-2 text-xs text-muted-foreground"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      {theme === 'dark' ? (
        <>
          <Sun className="h-3.5 w-3.5" />
          Light Mode
        </>
      ) : (
        <>
          <Moon className="h-3.5 w-3.5" />
          Dark Mode
        </>
      )}
    </Button>
  )
}
