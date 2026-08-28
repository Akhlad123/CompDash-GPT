import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type LLMProviderType = 'ollama' | 'gemini'

interface OllamaState {
  provider: LLMProviderType
  baseUrl: string
  model: string
  geminiApiKey: string
  geminiModel: string
  setProvider: (provider: LLMProviderType) => void
  setBaseUrl: (url: string) => void
  setModel: (model: string) => void
  setGeminiApiKey: (key: string) => void
  setGeminiModel: (model: string) => void
}

const ENV_BASE = (import.meta.env.VITE_OLLAMA_BASE as string | undefined) ?? 'http://localhost:11434'
const ENV_MODEL = (import.meta.env.VITE_OLLAMA_MODEL as string | undefined) ?? 'qwen3:14b'
const ENV_GEMINI_MODEL = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-3.5-flash-lite'

export const useOllamaStore = create<OllamaState>()(
  persist(
    (set) => ({
      provider: 'gemini' as LLMProviderType,
      baseUrl: ENV_BASE,
      model: ENV_MODEL,
      geminiApiKey: '',
      geminiModel: ENV_GEMINI_MODEL,
      setProvider: (provider) => set({ provider }),
      setBaseUrl: (url) => set({ baseUrl: url.trim().replace(/\/$/, '') }),
      setModel: (model) => set({ model: model.trim() }),
      setGeminiApiKey: (key) => set({ geminiApiKey: key.trim() }),
      setGeminiModel: (model) => set({ geminiModel: model.trim() }),
    }),
    {
      name: 'compdash-ollama-settings',
      version: 2,
      migrate: (persisted: unknown, _version: number) => {
        const state = persisted as Record<string, unknown>
        // Auto-migrate retired or rate-limited model names
        const retired = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-3.6-flash']
        if (typeof state.geminiModel === 'string' && retired.includes(state.geminiModel)) {
          state.geminiModel = 'gemini-3.5-flash-lite'
        }
        return state as unknown as OllamaState
      },
    }
  )
)

export function getLLMProvider(): LLMProviderType {
  return useOllamaStore.getState().provider || 'gemini'
}

export function getOllamaBaseUrl(): string {
  return useOllamaStore.getState().baseUrl || ENV_BASE
}

export function getOllamaModel(): string {
  return useOllamaStore.getState().model || ENV_MODEL
}

export function getGeminiApiKey(): string {
  return useOllamaStore.getState().geminiApiKey || ''
}

export function getGeminiModel(): string {
  return useOllamaStore.getState().geminiModel || ENV_GEMINI_MODEL
}
