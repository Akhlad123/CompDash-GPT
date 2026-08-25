export const askApiConfig = {
  apiUrl: import.meta.env.VITE_ASK_API_URL?.replace(/\/$/, '') ?? '',
  clientId: import.meta.env.VITE_ENTRA_CLIENT_ID ?? '',
  tenantId: import.meta.env.VITE_ENTRA_TENANT_ID ?? '',
  scope: import.meta.env.VITE_ENTRA_API_SCOPE ?? '',
}

export const isAskApiEnabled = Boolean(
  askApiConfig.apiUrl && askApiConfig.clientId && askApiConfig.tenantId && askApiConfig.scope
)
