export function parseBooleanQuery(value: string | undefined): boolean {
  return value === 'true' || value === '1'
}

export function appendStreamFlag(url: string, key: string, enabled: boolean): string {
  if (!enabled) {
    return url
  }

  return `${url}${url.includes('?') ? '&' : '?'}${key}=1`
}

export function rewriteManifest(manifest: string, key: string): string {
  return rewriteSessionManifest(manifest, { queryFlag: key })
}

export interface SessionManifestRewriteOptions {
  queryFlag?: string
  recoveryEpoch?: number
}

export function rewriteSessionManifest(manifest: string, options: SessionManifestRewriteOptions = {}): string {
  const shouldMarkDiscontinuity = typeof options.recoveryEpoch === 'number' && options.recoveryEpoch > 0
  let insertedDiscontinuitySequence = false
  let insertedDiscontinuity = false

  return manifest
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
        return shouldMarkDiscontinuity ? [] : [line]
      }

      const rewrittenLines: string[] = [line]

      if (shouldMarkDiscontinuity && !insertedDiscontinuitySequence && line.startsWith('#EXTM3U')) {
        rewrittenLines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${options.recoveryEpoch}`)
        insertedDiscontinuitySequence = true
      }

      if (!line || line.startsWith('#')) {
        return rewrittenLines
      }

      if (shouldMarkDiscontinuity && !insertedDiscontinuity) {
        rewrittenLines.splice(rewrittenLines.length - 1, 0, '#EXT-X-DISCONTINUITY')
        insertedDiscontinuity = true
      }

      const mediaLine = options.queryFlag
        ? `${line}${line.includes('?') ? '&' : '?'}${options.queryFlag}=1`
        : line
      rewrittenLines[rewrittenLines.length - 1] = mediaLine
      return rewrittenLines
    })
    .join('\n')
}

export function isValidSessionId(sessionId: string): boolean {
  return /^[a-z0-9-]+$/i.test(sessionId)
}

export function isValidAssetName(asset: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(asset) && !asset.includes('..') && !asset.includes('/') && !asset.includes('\\')
}

export function sendApiError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, statusCode: number, message: string, detail?: string) {
  return reply.code(statusCode).send({
    message,
    detail,
  })
}