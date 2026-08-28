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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useOllamaStore, type LLMProviderType } from '@/store/ollamaStore'

export default function OllamaSettingsDialog() {
  const {
    provider, baseUrl, model,
    geminiApiKey, geminiModel,
    setProvider, setBaseUrl, setModel,
    setGeminiApiKey, setGeminiModel,
  } = useOllamaStore()

  const [open, setOpen] = useState(false)
  const [draftProvider, setDraftProvider] = useState<LLMProviderType>(provider)
  const [draftBase, setDraftBase] = useState(baseUrl)
  const [draftModel, setDraftModel] = useState(model)
  const [draftGeminiKey, setDraftGeminiKey] = useState(geminiApiKey)
  const [draftGeminiModel, setDraftGeminiModel] = useState(geminiModel)

  const handleSave = () => {
    setProvider(draftProvider)
    setBaseUrl(draftBase)
    setModel(draftModel)
    setGeminiApiKey(draftGeminiKey)
    setGeminiModel(draftGeminiModel)
    setOpen(false)
  }

  const handleOpen = (isOpen: boolean) => {
    if (isOpen) {
      setDraftProvider(provider)
      setDraftBase(baseUrl)
      setDraftModel(model)
      setDraftGeminiKey(geminiApiKey)
      setDraftGeminiModel(geminiModel)
    }
    setOpen(isOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger>
        <span className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground underline decoration-dotted hover:text-foreground">
          <Settings2 className="h-3 w-3" />
          settings
        </span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>LLM Settings</DialogTitle>
          <DialogDescription>
            Choose your LLM provider and configure it. Settings are stored in your browser.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Provider</label>
            <Select value={draftProvider} onValueChange={(v) => setDraftProvider(v as LLMProviderType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gemini">Gemini (Google — cloud, free tier)</SelectItem>
                <SelectItem value="ollama">Ollama (local / self-hosted)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draftProvider === 'gemini' ? (
            <>
              <div className="grid gap-2">
                <label htmlFor="gemini-key" className="text-sm font-medium">
                  API Key
                </label>
                <Input
                  id="gemini-key"
                  type="password"
                  value={draftGeminiKey}
                  onChange={(e) => setDraftGeminiKey(e.target.value)}
                  placeholder="AIzaSy..."
                />
                <p className="text-xs text-muted-foreground">
                  Get a free key at{' '}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    aistudio.google.com/apikey
                  </a>
                </p>
              </div>
              <div className="grid gap-2">
                <label htmlFor="gemini-model" className="text-sm font-medium">
                  Model
                </label>
                <Select value={draftGeminiModel} onValueChange={(v) => { if (v) setDraftGeminiModel(v) }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite (recommended, highest free quota)</SelectItem>
                    <SelectItem value="gemini-3.7-flash">Gemini 3.7 Flash (latest)</SelectItem>
                    <SelectItem value="gemini-3.5-flash">Gemini 3.5 Flash</SelectItem>
                    <SelectItem value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
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
