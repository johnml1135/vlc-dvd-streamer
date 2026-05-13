import { access } from 'node:fs/promises'

export interface VlcDiscoveryResult {
  found: boolean
  path: string | null
}

export async function findVlc(candidates: string[]): Promise<VlcDiscoveryResult> {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { found: true, path: candidate }
    } catch {
      // Try the next candidate.
    }
  }

  return { found: false, path: null }
}