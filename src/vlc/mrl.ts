import { isDvdDriveLetter, isDvdIsoPath, normalizeDvdSource } from '../disc/dvd-source.js'

export interface DvdDiscMrlInput {
  drive: string
}

export interface DvdTitleMrlInput {
  drive: string
  titleNumber: number
}

export function buildDvdDiscMrl(input: DvdDiscMrlInput): string {
  const source = normalizeDvdSource(input.drive)
  if (isDvdDriveLetter(source)) return `dvd:///${source}/`
  const normalizedPath = encodeWindowsPath(source)
  return isDvdIsoPath(source) ? `dvd:///${normalizedPath}` : `dvd:///${normalizedPath}/`
}

export function buildDvdTitleMrl(input: DvdTitleMrlInput): string {
  if (!Number.isInteger(input.titleNumber) || input.titleNumber < 1) {
    throw new Error('DVD title number must be a positive integer.')
  }

  return `${buildDvdDiscMrl({ drive: input.drive })}#${input.titleNumber}`
}

function encodeWindowsPath(path: string): string {
  const slashPath = path.replaceAll('\\', '/')
  const match = /^([a-z]:)(?:\/(.*))?$/i.exec(slashPath)
  if (!match) throw new Error('DVD source path must be an absolute Windows path.')
  const root = match[1]!.toUpperCase()
  const segments = (match[2] ?? '').split('/').filter(Boolean).map((segment) => encodeURIComponent(segment))
  return [root, ...segments].join('/')
}
