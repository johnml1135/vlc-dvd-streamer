export function rewriteManifest(manifest: string, key: string): string {
  return rewriteSessionManifest(manifest, { queryFlag: key })
}

export interface SessionManifestRewriteOptions {
  queryFlag?: string
  recoveryEpoch?: number
}

/** Add one query parameter to media URIs without touching HLS tags. */
export function appendManifestQuery(manifest: string, key: string, value: string): string {
  const encoded = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith('#')) return line
      return `${line}${line.includes('?') ? '&' : '?'}${encoded}`
    })
    .join('\n')
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

      const mediaLine = options.queryFlag ? appendSessionQuery(line, options.queryFlag) : line
      rewrittenLines[rewrittenLines.length - 1] = mediaLine
      return rewrittenLines
    })
    .join('\n')
}

function appendSessionQuery(line: string, key: string): string {
  const query = `${encodeURIComponent(key)}=1`
  // Keep the long-standing generation/videoOnly ordering while retaining the
  // region identity at the end of region-qualified media URLs.
  const regionMarker = '&region='
  const regionIndex = line.indexOf(regionMarker)
  if (regionIndex >= 0) {
    return `${line.slice(0, regionIndex)}&${query}${line.slice(regionIndex)}`
  }
  return `${line}${line.includes('?') ? '&' : '?'}${query}`
}
