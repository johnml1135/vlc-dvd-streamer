import { win32 } from 'node:path'

export function normalizeDvdSource(source: string): string {
  const trimmed = source.trim()
  if (/^[a-z]:$/i.test(trimmed)) return trimmed.toUpperCase()
  if (win32.isAbsolute(trimmed)) return trimmed
  throw new Error('DVD source must be a drive letter like D: or an absolute Windows folder/ISO path.')
}

export function isDvdDriveLetter(source: string): boolean {
  return /^[a-z]:$/i.test(source.trim())
}

export function isDvdIsoPath(source: string): boolean {
  return /\.iso$/i.test(source.trim())
}
