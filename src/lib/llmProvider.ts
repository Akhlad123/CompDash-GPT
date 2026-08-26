import { getOllamaBaseUrl, getOllamaModel } from '@/store/ollamaStore'

// LLM provider abstraction. Browser code only uses OllamaProvider (local).
// Future server-side providers (OpenAI, Azure OpenAI) implement the same
// interface so the caller is never coupled to a specific backend.

export interface CompletionOptions {
  /** Sampling temperature. 0 = deterministic, 0.3 = slight variation */
  temperature?: number
  /** Hard token limit for the completion */
  maxTokens?: number
  /** Request timeout in milliseconds (default: 30 000) */
  timeoutMs?: number
  /** If true, parse response as JSON (sets format: 'json' in Ollama) */
  jsonMode?: boolean
  /** If true, disable chain-of-thought thinking (qwen3 / deepseek-r1) for faster JSON calls */
  disableThinking?: boolean
}

export interface CompletionResult {
  text: string
  /** Approximate prompt token count (when available from provider) */
  promptTokens?: number
  /** Approximate completion token count (when available from provider) */
  completionTokens?: number
  /** Wall-clock time for the LLM call in milliseconds */
  latencyMs: number
}

export interface LLMProviderError extends Error {
  code: 'timeout' | 'unavailable' | 'parse_error' | 'model_error' | 'unknown'
  provider: string
}

export interface LLMProvider {
  /** Blocking completion — returns full text when done */
  complete(
    userPrompt: string,
    systemPrompt: string,
    options?: CompletionOptions
  ): Promise<CompletionResult>

  /** Streaming completion — fires onToken for each token, resolves when done */
  stream(
    userPrompt: string,
    systemPrompt: string,
    onToken: (token: string) => void,
    options?: CompletionOptions
  ): Promise<CompletionResult>

  /** Model name string for display / logging */
  readonly modelName: string
}

// ─── Ollama provider ──────────────────────────────────────────────────────────

/** Current runtime Ollama configuration (env default, overridable via settings UI). */
export function getCurrentOllamaConfig(): { baseUrl: string; model: string } {
  return { baseUrl: getOllamaBaseUrl(), model: getOllamaModel() }
}

function makeLLMError(
  message: string,
  code: LLMProviderError['code'],
  provider: string
): LLMProviderError {
  const err = new Error(message) as LLMProviderError
  err.code = code
  err.provider = provider
  return err
}

class OllamaProvider implements LLMProvider {
  readonly modelName: string
  private readonly baseUrl: string

  constructor(model?: string, baseUrl?: string) {
    const cfg = getCurrentOllamaConfig()
    this.modelName = model ?? cfg.model
    this.baseUrl = (baseUrl ?? cfg.baseUrl).replace(/\/$/, '')
  }

  async complete(
    userPrompt: string,
    systemPrompt: string,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const {
      temperature = 0,
      maxTokens,
      timeoutMs = 30_000,
      jsonMode = false,
    } = options

    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()

    const body: Record<string, unknown> = {
      model: this.modelName,
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
      ...(options?.disableThinking ? { think: false } : {}),
      options: {
        temperature,
        ...(maxTokens != null ? { num_predict: maxTokens } : {}),
      },
    }
    if (jsonMode) body['format'] = 'json'

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timerId)
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      throw makeLLMError(
        isAbort
          ? `Ollama request timed out after ${timeoutMs}ms`
          : `Ollama unreachable at ${this.baseUrl}: ${String(err)}`,
        isAbort ? 'timeout' : 'unavailable',
        'ollama'
      )
    } finally {
      clearTimeout(timerId)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw makeLLMError(
        `Ollama returned HTTP ${response.status}: ${body.slice(0, 200)}`,
        'model_error',
        'ollama'
      )
    }

    let json: Record<string, unknown>
    try {
      json = (await response.json()) as Record<string, unknown>
    } catch {
      throw makeLLMError('Ollama response was not valid JSON', 'parse_error', 'ollama')
    }

    const text = typeof json['response'] === 'string' ? json['response'] : ''
    const latencyMs = Date.now() - started

    // Ollama eval_count fields (may be absent in older versions)
    const promptTokens = typeof json['prompt_eval_count'] === 'number'
      ? (json['prompt_eval_count'] as number)
      : undefined
    const completionTokens = typeof json['eval_count'] === 'number'
      ? (json['eval_count'] as number)
      : undefined

    return { text, promptTokens, completionTokens, latencyMs }
  }

  async stream(
    userPrompt: string,
    systemPrompt: string,
    onToken: (token: string) => void,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const {
      temperature = 0.3,
      maxTokens,
      timeoutMs = 60_000,
      jsonMode = false,
    } = options

    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()

    const body: Record<string, unknown> = {
      model: this.modelName,
      system: systemPrompt,
      prompt: userPrompt,
      stream: true,
      options: {
        temperature,
        ...(maxTokens != null ? { num_predict: maxTokens } : {}),
      },
    }
    if (jsonMode) body['format'] = 'json'

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timerId)
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      throw makeLLMError(
        isAbort ? `Ollama stream timed out after ${timeoutMs}ms` : `Ollama unreachable: ${String(err)}`,
        isAbort ? 'timeout' : 'unavailable',
        'ollama'
      )
    }

    if (!response.ok || !response.body) {
      clearTimeout(timerId)
      throw makeLLMError(`Ollama stream HTTP ${response.status}`, 'model_error', 'ollama')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let promptTokens: number | undefined
    let completionTokens: number | undefined

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>
          } catch {
            continue
          }
          if (typeof parsed['response'] === 'string') {
            const token = parsed['response'] as string
            fullText += token
            if (token) onToken(token)
          }
          if (parsed['done'] === true) {
            if (typeof parsed['prompt_eval_count'] === 'number') {
              promptTokens = parsed['prompt_eval_count'] as number
            }
            if (typeof parsed['eval_count'] === 'number') {
              completionTokens = parsed['eval_count'] as number
            }
          }
        }
      }
    } finally {
      clearTimeout(timerId)
      reader.releaseLock()
    }

    return { text: fullText, promptTokens, completionTokens, latencyMs: Date.now() - started }
  }
}

// ─── Factory + runtime provider ───────────────────────────────────────────────

/** Creates a new OllamaProvider with the current runtime config. */
export function createOllamaProvider(model?: string, baseUrl?: string): LLMProvider {
  return new OllamaProvider(model, baseUrl)
}

/** Returns a fresh provider using the current Ollama settings (env or user override). */
export function getOllamaProvider(): LLMProvider {
  return createOllamaProvider()
}

/** Current model name as configured. Useful for display tooltips. */
export function currentProviderModel(): string {
  return getOllamaModel()
}

/** Fire-and-forget warmup ping so Ollama loads the model into RAM before the user asks. */
export function warmupProvider(provider: LLMProvider = getOllamaProvider()): void {
  void provider
    .complete('ping', 'You are a warmup check. Reply with one word: ready.', {
      maxTokens: 4,
      timeoutMs: 5_000,
    })
    .catch(() => {/* silently ignore — model not running is fine at startup */})
}
