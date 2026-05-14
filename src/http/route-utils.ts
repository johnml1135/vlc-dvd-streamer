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
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith('#')) {
        return line
      }

      return `${line}${line.includes('?') ? '&' : '?'}${key}=1`
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