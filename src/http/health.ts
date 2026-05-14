import type { AppConfig } from '../config.js'
import { findVlc } from '../vlc/find-vlc.js'

export async function getHealthSnapshot(config: AppConfig) {
  const vlc = await findVlc(config.vlcCandidates)

  return {
    ok: vlc.found,
    dependencies: {
      vlc,
    },
  }
}