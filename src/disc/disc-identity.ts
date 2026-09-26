import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const IFO_FILE_PATTERN = /^(?:VIDEO_TS\.IFO|VTS_\d{2}_0\.IFO)$/i

/** Fingerprint DVD IFO contents without including the drive or mount path. */
export async function computeDiscIdentity(videoTsDir: string): Promise<string> {
  const names = (await readdir(videoTsDir))
    .filter((name) => IFO_FILE_PATTERN.test(name))
    .sort((left, right) => left.toUpperCase().localeCompare(right.toUpperCase()))

  if (!names.some((name) => name.toUpperCase() === 'VIDEO_TS.IFO')) {
    throw new Error(`Could not identify the DVD: ${videoTsDir} has no VIDEO_TS.IFO file.`)
  }

  const fingerprint = createHash('sha256')
  for (const name of names) {
    let contents: Buffer
    try {
      contents = await readFile(join(videoTsDir, name))
    } catch (error) {
      if (name.toUpperCase() === 'VIDEO_TS.IFO') throw error
      continue
    }

    fingerprint.update(name.toUpperCase()).update('\0').update(contents).update('\0')
  }

  return `disc-${fingerprint.digest('hex')}`
}
