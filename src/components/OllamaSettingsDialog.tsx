import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useOllamaStore } from '@/store/ollamaStore'

export default function OllamaSettingsDialog() {
  const { baseUrl, model, setBaseUrl, setModel } = useOllamaStore()
  const [open, setOpen] = useState(false)
  const [draftBase, setDraftBase] = useState(baseUrl)
  const [draftModel, setDraftModel] = useState(model)

  const handleSave = () => {
    setBaseUrl(draftBase)
    setModel(draftModel)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <span className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground underline decoration-dotted hover:text-foreground">
          <Settings2 className="h-3 w-3" />
          settings
        </span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ollama Settings</DialogTitle>
          <DialogDescription>
            Configure the Ollama endpoint used by the Ask a Question feature. Settings are stored in your browser.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label htmlFor="ollama-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="ollama-url"
              value={draftBase}
              onChange={(e) => setDraftBase(e.target.value)}
              placeholder="http://localhost:11434"
            />
            <p className="text-xs text-muted-foreground">
              For a shared server, use its IP/hostname, e.g. http://192.168.1.100:11434
            </p>
          </div>
          <div className="grid gap-2">
            <label htmlFor="ollama-model" className="text-sm font-medium">
              Model
            </label>
            <Input
              id="ollama-model"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              placeholder="qwen3:14b"
            />
            <p className="text-xs text-muted-foreground">
              Must already be pulled on the Ollama server.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
