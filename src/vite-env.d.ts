/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ASK_API_URL?: string
  readonly VITE_ENTRA_CLIENT_ID?: string
  readonly VITE_ENTRA_TENANT_ID?: string
  readonly VITE_ENTRA_API_SCOPE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
