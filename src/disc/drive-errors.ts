export const DRIVE_BUSY_MESSAGE = 'The DVD drive is in use by another program'

export function isDriveBusyMessage(message: string): boolean {
  return /(?:dvd|optical|disc|cd-rom)?\s*drive.{0,60}\b(?:busy|in use|locked|unavailable)\b/i.test(message)
    || /\b(?:busy|in use|locked)\b.{0,60}(?:dvd|optical|disc|cd-rom)?\s*drive/i.test(message)
    || /sharing violation|device is busy|resource busy/i.test(message)
}

export function userFacingDriveError(message: string, detail?: string): string {
  return isDriveBusyMessage(`${message} ${detail ?? ''}`) ? DRIVE_BUSY_MESSAGE : message
}
