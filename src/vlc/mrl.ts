export interface DvdDiscMrlInput {
  drive: string
}

export interface DvdTitleMrlInput {
  drive: string
  titleNumber: number
}

export function buildDvdDiscMrl(input: DvdDiscMrlInput): string {
  return `dvd:///${normalizeDrive(input.drive)}/`
}

export function buildDvdTitleMrl(input: DvdTitleMrlInput): string {
  if (!Number.isInteger(input.titleNumber) || input.titleNumber < 1) {
    throw new Error('DVD title number must be a positive integer.')
  }

  return `${buildDvdDiscMrl({ drive: input.drive })}#${input.titleNumber}`
}

function normalizeDrive(drive: string): string {
  const trimmed = drive.trim()
  if (!/^[a-z]:$/i.test(trimmed)) {
    throw new Error('DVD drive must be a Windows drive letter like D:.')
  }

  return trimmed.toUpperCase()
}