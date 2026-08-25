import { useState, useCallback } from 'react'
import { Link, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getShareURL } from '@/lib/shareLink'

export default function ShareLinkButton() {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const url = getShareURL()
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  return (
    <Button variant="outline" size="sm" onClick={handleCopy}>
      {copied ? (
        <Check className="mr-1 h-3.5 w-3.5 text-green-500" />
      ) : (
        <Link className="mr-1 h-3.5 w-3.5" />
      )}
      {copied ? 'Copied!' : 'Share'}
    </Button>
  )
}
