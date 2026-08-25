import { useCallback, useState } from 'react'
import { isAskApiEnabled } from '../api/config'
import { submitAskQuestion, type AskApiArtifact, type AskApiRun } from '../api/client'

export function useAskApiQuestion() {
  const [run, setRun] = useState<AskApiRun | null>(null)
  const [artifacts, setArtifacts] = useState<AskApiArtifact[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const ask = useCallback(async (question: string) => {
    setIsLoading(true)
    setError(null)
    setArtifacts([])
    try {
      const response = await submitAskQuestion(question)
      setRun(response.run)
      setArtifacts(response.artifacts)
      return response
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw cause
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { enabled: isAskApiEnabled, run, artifacts, error, isLoading, ask }
}
