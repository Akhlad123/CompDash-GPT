import { PublicClientApplication } from '@azure/msal-browser'
import { z } from 'zod'
import { askApiConfig, isAskApiEnabled } from './config'

const runSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  status: z.enum(['accepted', 'clarification_required', 'planning', 'executing', 'analyzing', 'completed', 'failed', 'cancelled']),
  request_id: z.string().uuid(),
  correlation_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
})

const artifactSchema = z.object({
  id: z.string().uuid(),
  analysis_run_id: z.string().uuid(),
  artifact_type: z.string(),
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  row_count: z.number().int().nullable(),
  created_at: z.string(),
})

export type AskApiRun = z.infer<typeof runSchema>
export type AskApiArtifact = z.infer<typeof artifactSchema>

let msalClient: PublicClientApplication | null = null
let initialized = false

function getMsalClient(): PublicClientApplication {
  if (!isAskApiEnabled) throw new Error('Ask API mode is not configured.')
  msalClient ??= new PublicClientApplication({
    auth: {
      clientId: askApiConfig.clientId,
      authority: `https://login.microsoftonline.com/${askApiConfig.tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'sessionStorage' },
  })
  return msalClient
}

async function getAccessToken(): Promise<string> {
  const client = getMsalClient()
  if (!initialized) {
    await client.initialize()
    initialized = true
  }
  const account = client.getActiveAccount() ?? client.getAllAccounts()[0]
  const request = { scopes: [askApiConfig.scope], account }
  const result = account
    ? await client.acquireTokenSilent(request).catch(() => client.acquireTokenPopup(request))
    : await client.loginPopup({ scopes: [askApiConfig.scope] })
  if (!account) client.setActiveAccount(result.account)
  return result.accessToken
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken()
  const response = await fetch(`${askApiConfig.apiUrl}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `Ask API request failed (${response.status}).`)
  return response
}

export async function submitAskQuestion(question: string): Promise<{ run: AskApiRun; artifacts: AskApiArtifact[] }> {
  const conversationResponse = await apiFetch('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: question.slice(0, 500), context: {} }),
  })
  const conversation = z.object({ id: z.string().uuid() }).parse(await conversationResponse.json())
  const runResponse = await apiFetch(`/conversations/${conversation.id}/questions`, {
    method: 'POST',
    body: JSON.stringify({ question, scope: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, client_request_id: crypto.randomUUID() }),
  })
  const run = runSchema.parse(await runResponse.json())
  const artifactResponse = await apiFetch(`/analysis-runs/${run.id}/artifacts`)
  return { run, artifacts: z.array(artifactSchema).parse(await artifactResponse.json()) }
}
