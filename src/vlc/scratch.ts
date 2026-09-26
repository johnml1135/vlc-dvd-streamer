import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function createVlcScratchDir(parentDir: string): Promise<string> {
  await mkdir(parentDir, { recursive: true })
  return mkdtemp(join(parentDir, '.vlc-run-'))
}

export async function removeVlcScratchDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
