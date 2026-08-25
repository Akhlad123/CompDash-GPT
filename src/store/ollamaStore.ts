import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OllamaState {
  baseUrl: string
  model: string
  setBaseUrl: (url: string) => void
  setModel: (model: string) => void
}

const ENV_BASE = (import.meta.env.VITE_OLLAMA_BASE as string | undefined) ?? 'http://localhost:11434'
const ENV_MODEL = (import.meta.env.VITE_OLLAMA_MODEL as string | undefined) ?? 'qwen3:14b'

export const useOllamaStore = create<OllamaState>()(
  persist(
    (set) => ({
      baseUrl: ENV_BASE,
      model: ENV_MODEL,
      setBaseUrl: (url) => set({ baseUrl: url.trim().replace(/\/$/, '') }),
      setModel: (model) => set({ model: model.trim() }),
    }),
    {
      name: 'compdash-ollama-settings',
    }
  )
)

export function getOllamaBaseUrl(): string {
  return useOllamaStore.getState().baseUrl || ENV_BASE
}

export function getOllamaModel(): string {
  return useOllamaStore.getState().model || ENV_MODEL
}
