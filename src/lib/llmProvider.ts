import { getOllamaBaseUrl, getOllamaModel, getLLMProvider, getGeminiApiKey, getGeminiModel } from '@/store/ollamaStore'

// LLM provider abstraction. Supports Ollama (local) and Gemini (cloud).
// The caller is never coupled to a specific backend.

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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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

// ─── Gemini helpers ─────────────────────────────────────────────────────────

function extractGeminiResponse(json: Record<string, unknown>): {
  text: string; promptTokens?: number; completionTokens?: number
} {
  const candidates = json['candidates'] as Array<Record<string, unknown>> | undefined
  let text = ''
  if (candidates && candidates.length > 0) {
    const content = candidates[0]['content'] as Record<string, unknown> | undefined
    if (content) {
      const parts = content['parts'] as Array<Record<string, unknown>> | undefined
      if (parts) {
        text = parts
          .filter((p) => !p['thought'])
          .map((p) => (typeof p['text'] === 'string' ? p['text'] : ''))
          .join('')
      }
    }
  }
  const usageMetadata = json['usageMetadata'] as Record<string, unknown> | undefined
  const promptTokens = typeof usageMetadata?.['promptTokenCount'] === 'number'
    ? (usageMetadata['promptTokenCount'] as number) : undefined
  const completionTokens = typeof usageMetadata?.['candidatesTokenCount'] === 'number'
    ? (usageMetadata['candidatesTokenCount'] as number) : undefined
  return { text, promptTokens, completionTokens }
}

// ─── Gemini provider ────────────────────────────────────────────────────────

class GeminiProvider implements LLMProvider {
  readonly modelName: string
  private readonly apiKey: string

  constructor(model?: string, apiKey?: string) {
    this.modelName = model ?? getGeminiModel()
    this.apiKey = apiKey ?? getGeminiApiKey()
  }

  async complete(
    userPrompt: string,
    systemPrompt: string,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const {
      temperature = 0,
      maxTokens,
      timeoutMs = 60_000,
      jsonMode = false,
    } = options

    if (!this.apiKey) {
      throw makeLLMError(
        'Gemini API key not configured. Go to settings and enter your API key.',
        'unavailable',
        'gemini'
      )
    }

    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`

    const body: Record<string, unknown> = {
      contents: [
        { role: 'user', parts: [{ text: userPrompt }] },
      ],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature,
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timerId)
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      throw makeLLMError(
        isAbort
          ? `Gemini request timed out after ${timeoutMs}ms`
          : `Gemini unreachable: ${String(err)}`,
        isAbort ? 'timeout' : 'unavailable',
        'gemini'
      )
    } finally {
      clearTimeout(timerId)
    }

    // Retry on 429 rate-limit with exponential backoff (up to 2 retries)
    if (response.status === 429) {
      clearTimeout(timerId)
      for (let attempt = 1; attempt <= 2; attempt++) {
        const delay = attempt * 3000 // 3s, 6s
        console.debug(`[Gemini] Rate limited, retrying in ${delay}ms (attempt ${attempt}/2)`)
        await new Promise((r) => setTimeout(r, delay))
        const retryController = new AbortController()
        const retryTimer = setTimeout(() => retryController.abort(), timeoutMs)
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: retryController.signal,
          })
          clearTimeout(retryTimer)
          if (response.ok) break
          if (response.status !== 429) break
        } catch {
          clearTimeout(retryTimer)
        }
      }
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      throw makeLLMError(
        `Gemini returned HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        response.status === 429 ? 'timeout' : 'model_error',
        'gemini'
      )
    }

    let json: Record<string, unknown>
    try {
      json = (await response.json()) as Record<string, unknown>
    } catch {
      throw makeLLMError('Gemini response was not valid JSON', 'parse_error', 'gemini')
    }

    const { text: extractedText, promptTokens, completionTokens } = extractGeminiResponse(json)
    console.debug('[Gemini complete] raw text:', extractedText.slice(0, 300))

    return { text: extractedText, promptTokens, completionTokens, latencyMs: Date.now() - started }
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

    if (!this.apiKey) {
      throw makeLLMError(
        'Gemini API key not configured. Go to settings and enter your API key.',
        'unavailable',
        'gemini'
      )
    }

    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:streamGenerateContent?key=${this.apiKey}&alt=sse`

    const body: Record<string, unknown> = {
      contents: [
        { role: 'user', parts: [{ text: userPrompt }] },
      ],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature,
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timerId)
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      throw makeLLMError(
        isAbort ? `Gemini stream timed out after ${timeoutMs}ms` : `Gemini unreachable: ${String(err)}`,
        isAbort ? 'timeout' : 'unavailable',
        'gemini'
      )
    }

    // Retry on 429 rate-limit with backoff (up to 2 retries)
    if (response.status === 429) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const delay = attempt * 3000
        console.debug(`[Gemini stream] Rate limited, retrying in ${delay}ms (attempt ${attempt}/2)`)
        await new Promise((r) => setTimeout(r, delay))
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          if (response.ok) break
          if (response.status !== 429) break
        } catch { /* retry */ }
      }
    }

    if (!response.ok || !response.body) {
      clearTimeout(timerId)
      const errBody = await response.text().catch(() => '')
      throw makeLLMError(`Gemini stream HTTP ${response.status}: ${errBody.slice(0, 200)}`, 'model_error', 'gemini')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let promptTokens: number | undefined
    let completionTokens: number | undefined

    try {
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const jsonStr = trimmed.slice(6)
          if (jsonStr === '[DONE]') continue

          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(jsonStr) as Record<string, unknown>
          } catch {
            continue
          }

          const candidates = parsed['candidates'] as Array<Record<string, unknown>> | undefined
          if (candidates && candidates.length > 0) {
            const content = candidates[0]['content'] as Record<string, unknown> | undefined
            if (content) {
              const parts = content['parts'] as Array<Record<string, unknown>> | undefined
              if (parts) {
                for (const part of parts) {
                  // Skip thinking tokens — only emit actual text
                  if (part['thought']) continue
                  if (typeof part['text'] === 'string' && part['text']) {
                    fullText += part['text']
                    onToken(part['text'] as string)
                  }
                }
              }
            }
          }

          const usageMetadata = parsed['usageMetadata'] as Record<string, unknown> | undefined
          if (usageMetadata) {
            if (typeof usageMetadata['promptTokenCount'] === 'number') {
              promptTokens = usageMetadata['promptTokenCount'] as number
            }
            if (typeof usageMetadata['candidatesTokenCount'] === 'number') {
              completionTokens = usageMetadata['candidatesTokenCount'] as number
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

/** Creates a new GeminiProvider with the current runtime config. */
export function createGeminiProvider(model?: string, apiKey?: string): LLMProvider {
  return new GeminiProvider(model, apiKey)
}

/** Returns a fresh provider using the current settings (auto-selects Ollama or Gemini). */
export function getOllamaProvider(): LLMProvider {
  const providerType = getLLMProvider()
  if (providerType === 'gemini') return createGeminiProvider()
  return createOllamaProvider()
}

/** Current model name as configured. Useful for display tooltips. */
export function currentProviderModel(): string {
  const providerType = getLLMProvider()
  if (providerType === 'gemini') return getGeminiModel()
  return getOllamaModel()
}

/** Current provider label for display. */
export function currentProviderLabel(): string {
  return getLLMProvider() === 'gemini' ? 'Gemini' : 'Ollama'
}

/** Fire-and-forget warmup ping so the provider is ready before the user asks. */
export function warmupProvider(provider: LLMProvider = getOllamaProvider()): void {
  if (getLLMProvider() === 'gemini') return // Gemini doesn't need warmup
  void provider
    .complete('ping', 'You are a warmup check. Reply with one word: ready.', {
      maxTokens: 4,
      timeoutMs: 5_000,
    })
    .catch(() => {/* silently ignore — model not running is fine at startup */})
}
