import type { CatalogSnapshot, DiscTitle } from '../disc/types.js'
import type { PlaybackSession } from '../session/session-manager.js'

interface HomePageInput {
  health: {
    ok: boolean
    dependencies: {
      vlc: {
        found: boolean
        path: string | null
      }
    }
  }
  snapshot: CatalogSnapshot
  titles: DiscTitle[]
  includeShort: boolean
  activeSession?: PlaybackSession
}

interface PlayerPageInput {
  session: PlaybackSession
  manifestUrl?: string
}

export function renderHomePage(input: HomePageInput): string {
  const content = input.snapshot.state === 'catalog_ready'
    ? renderCatalog(input)
    : renderWaiting(input)

  return renderLayout({
    title: 'DVD Streamer',
    eyebrow: 'Living-room appliance',
    headline: 'DVD Streamer',
    summary: 'Insert a disc, pick a title, and launch a single browser session through the server-owned VLC pipeline.',
    status: input.health.dependencies.vlc.found
      ? `VLC ready at ${input.health.dependencies.vlc.path}`
      : 'VLC not found',
    content,
  })
}

export function renderPlayerPage(input: PlayerPageInput): string {
  const session = input.session
  const manifestUrl = input.manifestUrl ?? session.manifestUrl
  const durationSeconds = session.timeline?.durationSeconds ?? session.durationSeconds ?? 0
  const currentRange = session.timeline?.currentRange ?? { startSeconds: 0, endSeconds: 0 }
  const stitchedManifestUrl = session.timeline?.stitchedManifestUrl ?? session.manifestUrl.replace(/index\.m3u8(?:\?.*)?$/, 'stitched.m3u8')
  const recoveryEpoch = session.recovery?.epoch ?? 0

  return renderLayout({
    title: 'Now Playing',
    eyebrow: 'Active session',
    headline: `Title ${session.titleNumber}`,
    summary: 'The browser receives only app-server HLS URLs. The server owns session replacement, cleanup, and process lifetime.',
    status: `Session ${session.state}`,
    content: `
      <section class="player-shell">
        <div class="player-meta">
          <p class="meta-label">Manifest URL</p>
          <a class="manifest-link" href="${escapeHtml(manifestUrl)}">${escapeHtml(manifestUrl)}</a>
        </div>
        <video id="player" controls playsinline muted data-manifest-url="${escapeHtml(manifestUrl)}" data-session-id="${escapeHtml(session.id)}" data-duration-seconds="${durationSeconds}" data-epoch-start-seconds="${currentRange.startSeconds}" data-recovery-epoch="${recoveryEpoch}"></video>
        <p id="player-status" class="player-status">Attaching HLS stream...</p>
        <div class="title-timeline" data-stitched-manifest-url="${escapeHtml(stitchedManifestUrl)}">
          <div class="title-timeline-row">
            <label for="title-seek">Title position</label>
            <span><span id="title-current-time">${escapeHtml(formatClock(currentRange.startSeconds))}</span> / <span id="title-duration">${escapeHtml(formatClock(durationSeconds))}</span></span>
          </div>
          <input id="title-seek" type="range" min="0" max="${Math.max(0, Math.floor(durationSeconds))}" step="1" value="${Math.max(0, Math.floor(currentRange.startSeconds))}" ${durationSeconds > 0 ? '' : 'disabled'} />
          <div class="title-timeline-row title-timeline-foot">
            <span id="title-buffered-summary">Cached through ${escapeHtml(formatClock(currentRange.endSeconds))}</span>
            <a class="manifest-link" href="${escapeHtml(stitchedManifestUrl)}">Stitched cache</a>
          </div>
        </div>
        <div class="player-actions">
          <a class="ghost-link" href="/">Back to titles</a>
          <form method="post" action="/actions/sessions/${escapeHtml(session.id)}/stop">
            <button type="submit">Stop Stream</button>
          </form>
        </div>
      </section>
      <script type="module">
        const video = document.getElementById('player')
        const status = document.getElementById('player-status')
        const manifestUrl = video && video.dataset ? video.dataset.manifestUrl : undefined
        const sessionId = video && video.dataset ? video.dataset.sessionId : undefined
        const durationSeconds = video && video.dataset ? Number(video.dataset.durationSeconds || '0') : 0
        const seekControl = document.getElementById('title-seek')
        const titleCurrentTime = document.getElementById('title-current-time')
        const bufferedSummary = document.getElementById('title-buffered-summary')
        let epochStartSeconds = video && video.dataset ? Number(video.dataset.epochStartSeconds || '0') : 0
        let activeHls = null
        let nativeHlsActive = false
        let playbackManifestUrl = manifestUrl
        let shouldResetPlaybackToZero = true
        let activeRecoveryEpoch = video && video.dataset ? Number(video.dataset.recoveryEpoch || '0') : 0

        function appendStreamFlag(url, key) {
          if (url.indexOf(key + '=1') !== -1) {
            return url
          }

          return url + (url.includes('?') ? '&' : '?') + key + '=1'
        }

        function appendReloadToken(url) {
          return url + (url.includes('?') ? '&' : '?') + 'reload=' + Date.now()
        }

        function formatClock(totalSeconds) {
          const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
          const hours = Math.floor(safeSeconds / 3600)
          const minutes = Math.floor((safeSeconds % 3600) / 60)
          const seconds = safeSeconds % 60
          if (hours > 0) {
            return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
          }

          return minutes + ':' + String(seconds).padStart(2, '0')
        }

        function currentTitleSeconds() {
          return epochStartSeconds + (video ? video.currentTime : 0)
        }

        function isTitleTimeBuffered(titleSeconds) {
          if (!video || !Number.isFinite(titleSeconds)) {
            return false
          }

          for (let index = 0; index < video.buffered.length; index += 1) {
            const startSeconds = epochStartSeconds + video.buffered.start(index)
            const endSeconds = epochStartSeconds + video.buffered.end(index)
            if (titleSeconds >= startSeconds && titleSeconds <= endSeconds) {
              return true
            }
          }

          return false
        }

        function updateTimelineUi() {
          if (titleCurrentTime) {
            titleCurrentTime.textContent = formatClock(currentTitleSeconds())
          }

          if (seekControl && document.activeElement !== seekControl) {
            seekControl.value = String(Math.min(durationSeconds || currentTitleSeconds(), currentTitleSeconds()))
          }

          if (bufferedSummary && video) {
            const ranges = []
            for (let index = 0; index < video.buffered.length; index += 1) {
              ranges.push(formatClock(epochStartSeconds + video.buffered.start(index)) + '-' + formatClock(epochStartSeconds + video.buffered.end(index)))
            }
            bufferedSummary.textContent = ranges.length > 0
              ? 'Buffered: ' + ranges.join(', ')
              : 'Buffering current title range'
          }
        }

        function recoveryEpochFromSession(session) {
          const epoch = session && session.recovery ? Number(session.recovery.epoch) : NaN
          return Number.isFinite(epoch) ? epoch : null
        }

        function applySessionTimeline(session) {
          if (!session || !session.timeline) {
            return
          }

          if (session.timeline.currentRange && typeof session.timeline.currentRange.startSeconds === 'number') {
            epochStartSeconds = session.timeline.currentRange.startSeconds
            if (video && video.dataset) {
              video.dataset.epochStartSeconds = String(epochStartSeconds)
            }
          }

          const recoveryEpoch = recoveryEpochFromSession(session)
          if (recoveryEpoch !== null) {
            activeRecoveryEpoch = recoveryEpoch
            if (video && video.dataset) {
              video.dataset.recoveryEpoch = String(activeRecoveryEpoch)
            }
          }

          updateTimelineUi()
        }

        function syncRecoveredSession(payload) {
          if (!payload || typeof payload !== 'object' || payload.sessionId !== sessionId || payload.status !== 'idle') {
            return
          }

          const recoveredSession = payload.session
          const recoveryEpoch = recoveryEpochFromSession(recoveredSession)
          if (recoveryEpoch === null || recoveryEpoch <= activeRecoveryEpoch) {
            return
          }

          applySessionTimeline(recoveredSession)
          reloadPlaybackSource()
        }

        function seekWithinCurrentMedia(titleSeconds) {
          if (!video) {
            return
          }

          video.currentTime = Math.max(0, titleSeconds - epochStartSeconds)
          updateTimelineUi()
        }

        function reloadPlaybackSource() {
          if (!video || !playbackManifestUrl) {
            return
          }

          shouldResetPlaybackToZero = true
          const nextUrl = appendReloadToken(playbackManifestUrl)
          if (activeHls && typeof activeHls.loadSource === 'function') {
            activeHls.loadSource(nextUrl)
            if (typeof activeHls.startLoad === 'function') {
              activeHls.startLoad(0)
            }
            return
          }

          if (nativeHlsActive) {
            video.src = nextUrl
            video.load()
          }
        }

        function resetPlaybackToWindowStart() {
          if (!video || !shouldResetPlaybackToZero) {
            return
          }

          try {
            video.currentTime = 0
            shouldResetPlaybackToZero = false
            updateTimelineUi()
          } catch {
          }
        }

        async function seekTitleTo(titleSeconds) {
          if (!video || !status || !sessionId || !Number.isFinite(titleSeconds)) {
            return
          }

          if (isTitleTimeBuffered(titleSeconds)) {
            seekWithinCurrentMedia(titleSeconds)
            status.textContent = 'Playing from the existing buffer.'
            return
          }

          status.textContent = 'Seeking to ' + formatClock(titleSeconds) + ' and buffering from the DVD.'
          const response = await fetch('/api/sessions/' + sessionId + '/seek', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionSeconds: titleSeconds }),
          })
          if (!response.ok) {
            status.textContent = 'Could not seek to ' + formatClock(titleSeconds) + '.'
            return
          }

          const result = await response.json()
          applySessionTimeline(result.session)
          if (result.action === 'already-available') {
            seekWithinCurrentMedia(result.positionSeconds)
            status.textContent = 'Playing from the current HLS window.'
            return
          }

          reloadPlaybackSource()
          status.textContent = 'Buffering from ' + formatClock(result.positionSeconds) + '.'
        }

        async function attachStream() {
          if (!video || !manifestUrl || !status) {
            return
          }

          const userAgent = navigator.userAgent
          const isEmbeddedCodeBrowser = userAgent.includes('Code/')
          const isChromiumBrowser = /Chrom(e|ium)|Edg|OPR|Electron/.test(userAgent) || isEmbeddedCodeBrowser
          const prefersNativeHls = video.canPlayType('application/vnd.apple.mpegurl')
            && /Safari\\//.test(userAgent)
            && !isChromiumBrowser
          playbackManifestUrl = isEmbeddedCodeBrowser
            ? appendStreamFlag(manifestUrl, 'videoOnly')
            : manifestUrl

          try {
            const module = await import('/assets/hls.mjs')
            const Hls = module.default

            if (!prefersNativeHls && Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
              const hls = new Hls({
                startPosition: 0,
                liveMaxUnchangedPlaylistRefresh: 3,
                detectStallWithCurrentTimeMs: 1250,
                highBufferWatchdogPeriod: 2,
                nudgeMaxRetry: 5,
                handleMpegTsVideoIntegrityErrors: 'skip',
                fragLoadPolicy: {
                  default: {
                    maxTimeToFirstByteMs: 10000,
                    maxLoadTimeMs: 30000,
                    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 1000 },
                    errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 4000, backoff: 'linear' },
                  },
                },
              })
              activeHls = hls
              let lastMediaRecoveryAt = 0
              if (Hls.Events && Hls.Events.MANIFEST_PARSED) {
                hls.on(Hls.Events.MANIFEST_PARSED, resetPlaybackToWindowStart)
              }
              hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data || !status) {
                  return
                }

                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.fatal) {
                  const now = Date.now()
                  if (now - lastMediaRecoveryAt > 5000 && typeof hls.recoverMediaError === 'function') {
                    lastMediaRecoveryAt = now
                    status.textContent = 'Recovering the video decoder after a stream discontinuity.'
                    hls.recoverMediaError()
                  }
                  return
                }

                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                  status.textContent = 'Waiting for recovered HLS data from the server.'
                  if (data.fatal && typeof hls.startLoad === 'function') {
                    hls.startLoad(-1)
                  }
                }
              })
              hls.loadSource(playbackManifestUrl)
              hls.attachMedia(video)
              status.textContent = isEmbeddedCodeBrowser
                ? 'Using hls.js fallback without audio in the embedded browser.'
                : 'Using hls.js fallback.'
              return
            }
          } catch (error) {
            // Fall back to a clear message below.
          }

          if (prefersNativeHls) {
            nativeHlsActive = true
            video.src = playbackManifestUrl
            status.textContent = 'Using native HLS support.'
            return
          }

          status.textContent = 'Manifest is ready. This browser needs native HLS or hls.js support to render the stream.'
        }

        void attachStream()
        window.addEventListener('vlc-dvd-streamer:session-recovery', (event) => {
          syncRecoveredSession(event.detail)
        })
        if (video) {
          video.addEventListener('timeupdate', updateTimelineUi)
          video.addEventListener('progress', updateTimelineUi)
          video.addEventListener('loadedmetadata', resetPlaybackToWindowStart)
          video.addEventListener('playing', resetPlaybackToWindowStart)
        }
        if (seekControl) {
          seekControl.addEventListener('input', () => {
            if (titleCurrentTime) {
              titleCurrentTime.textContent = formatClock(Number(seekControl.value))
            }
          })
          seekControl.addEventListener('change', () => {
            void seekTitleTo(Number(seekControl.value))
          })
        }
      </script>
    `,
  })
}

function renderCatalog(input: HomePageInput): string {
  const disc = input.snapshot.disc
  if (!disc) {
    return renderWaiting(input)
  }

  const titleCards = input.titles.map((title) => `
    <article class="title-card">
      <img src="${escapeHtml(title.thumbnailUrl)}" alt="Thumbnail for ${escapeHtml(title.label)}" loading="lazy" />
      <div class="title-copy">
        <div class="title-heading-row">
          <h3>${escapeHtml(title.label)}</h3>
          ${title.likelyMainFeature ? '<span class="badge">Main feature</span>' : ''}
        </div>
        <p>${formatDuration(title.durationSeconds)}</p>
        <form method="post" action="/actions/play" class="play-form">
          <input type="hidden" name="discId" value="${escapeHtml(disc.discId)}" />
          <input type="hidden" name="titleNumber" value="${title.titleNumber}" />
          <label>
            Audio
            <select name="audioTrack">
              <option value="">Auto (English preferred)</option>
              ${title.audioTracks.map((track) => `<option value="${track.id}">${escapeHtml(track.label)}</option>`).join('')}
            </select>
          </label>
          <label>
            Subtitles
            <select name="subtitleTrack">
              <option value="">Off</option>
              ${title.subtitleTracks.map((track) => `<option value="${track.id}">${escapeHtml(track.label)}</option>`).join('')}
            </select>
          </label>
          <button type="submit">Start Stream</button>
        </form>
      </div>
    </article>
  `).join('')

  return `
    <section class="toolbar">
      <div>
        <p class="meta-label">Current disc</p>
        <h2>${escapeHtml(disc.discId)}</h2>
      </div>
      <div class="toolbar-actions">
        <form method="post" action="/actions/refresh">
          <button type="submit">Refresh Disc</button>
        </form>
        <a class="ghost-link" href="/${input.includeShort ? '' : '?includeShort=true'}">${input.includeShort ? 'Hide extras' : 'Show extras'}</a>
      </div>
    </section>
    ${input.activeSession ? `
      <section class="active-banner">
        <div>
          <p class="meta-label">Active stream</p>
          <strong>Title ${input.activeSession.titleNumber}</strong>
        </div>
        <div class="toolbar-actions">
          <a class="ghost-link" href="/player/${escapeHtml(input.activeSession.id)}">Open player</a>
          <form method="post" action="/actions/sessions/${escapeHtml(input.activeSession.id)}/stop">
            <button type="submit">Stop Stream</button>
          </form>
        </div>
      </section>
    ` : ''}
    <section class="catalog-grid">
      ${titleCards}
    </section>
  `
}

function renderWaiting(input: HomePageInput): string {
  const loadingDetail = (() => {
    const progress = input.snapshot.progress
    if (!progress || progress.totalTitles === null) {
      return 'The catalog is still being generated.'
    }

    const progressLabel = `${progress.scannedTitles} of ${progress.totalTitles} titles scanned`
    if (progress.currentTitleNumber !== null) {
      return `${progressLabel}. Reading title ${progress.currentTitleNumber}.`
    }

    return `${progressLabel}. Finalizing the catalog.`
  })()

  const messageByState: Record<string, { title: string; detail: string }> = {
    empty: {
      title: 'Insert a DVD to begin.',
      detail: 'The server can see the optical path, but no playable disc metadata is available yet.',
    },
    no_drive: {
      title: 'No optical drive detected.',
      detail: 'Attach a DVD drive or configure the expected drive letter before refreshing.',
    },
    disc_detected: {
      title: 'Disc detected.',
      detail: 'The server is handing the disc over to the VLC worker for scanning.',
    },
    catalog_loading: {
      title: 'Reading titles from the disc.',
      detail: loadingDetail,
    },
    disc_removed: {
      title: 'The disc was removed.',
      detail: 'Insert the disc again and refresh to rebuild the catalog.',
    },
    catalog_error: {
      title: input.snapshot.error?.message ?? 'Catalog generation failed.',
      detail: input.snapshot.error?.detail ?? 'The VLC worker could not build a title catalog.',
    },
  }

  const state = messageByState[input.snapshot.state] ?? messageByState.empty

  return `
    <section class="waiting-card">
      <p class="meta-label">Disc state</p>
      <h2>${escapeHtml(state.title)}</h2>
      <p>${escapeHtml(state.detail)}</p>
      <form method="post" action="/actions/refresh">
        <button type="submit">Refresh Disc</button>
      </form>
    </section>
  `
}

function renderLayout(input: {
  title: string
  eyebrow: string
  headline: string
  summary: string
  status: string
  content: string
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4ecdf;
        --panel: rgba(255, 249, 240, 0.88);
        --panel-strong: #fffaf2;
        --ink: #20160f;
        --muted: #6e5a4d;
        --accent: #b04f25;
        --accent-dark: #8f3814;
        --line: rgba(32, 22, 15, 0.12);
        --badge: #2d6a4f;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Bahnschrift, Aptos, 'Segoe UI Variable', sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(255, 221, 163, 0.8), transparent 28%),
          radial-gradient(circle at right, rgba(176, 79, 37, 0.18), transparent 24%),
          linear-gradient(180deg, #f7efe4 0%, #efe3d1 100%);
      }

      a { color: inherit; }

      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }

      .hero {
        display: grid;
        gap: 16px;
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: var(--panel);
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 60px rgba(64, 34, 14, 0.12);
      }

      .eyebrow,
      .meta-label {
        margin: 0;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.73rem;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: clamp(2.4rem, 5vw, 4.6rem);
        line-height: 0.95;
      }

      .hero-row,
      .toolbar,
      .toolbar-actions,
      .active-banner,
      .title-heading-row,
      .player-actions {
        display: flex;
        gap: 16px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
      }

      .status-pill,
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.7);
        border: 1px solid var(--line);
      }

      .badge {
        background: rgba(45, 106, 79, 0.14);
        color: var(--badge);
        font-size: 0.84rem;
      }

      .toolbar,
      .active-banner,
      .waiting-card,
      .player-shell,
      .log-drawer {
        margin-top: 24px;
        padding: 22px;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: var(--panel-strong);
      }

      .catalog-grid {
        display: grid;
        gap: 18px;
        margin-top: 24px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }

      .title-card {
        overflow: hidden;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.75);
        box-shadow: 0 18px 36px rgba(64, 34, 14, 0.08);
      }

      .title-card img {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        background: linear-gradient(135deg, #dbc5a8, #f8f2e7);
      }

      .title-copy,
      .play-form {
        display: grid;
        gap: 14px;
      }

      .title-copy {
        padding: 18px;
      }

      .play-form label {
        display: grid;
        gap: 6px;
        color: var(--muted);
      }

      input,
      select,
      button,
      .ghost-link {
        font: inherit;
      }

      select,
      button,
      .ghost-link {
        min-height: 44px;
        border-radius: 14px;
        border: 1px solid var(--line);
      }

      select {
        padding: 0 12px;
        background: white;
      }

      button,
      .ghost-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 16px;
        text-decoration: none;
        cursor: pointer;
      }

      button {
        background: var(--accent);
        color: white;
        border-color: transparent;
      }

      button:hover { background: var(--accent-dark); }

      .ghost-link {
        background: transparent;
      }

      video {
        width: 100%;
        border-radius: 20px;
        background: #100a07;
        min-height: 320px;
      }

      .manifest-link,
      .player-status {
        color: var(--muted);
      }

      .title-timeline {
        display: grid;
        gap: 10px;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.54);
      }

      .title-timeline-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }

      .title-timeline input[type="range"] {
        width: 100%;
      }

      .title-timeline-foot {
        color: var(--muted);
        font-size: 0.92rem;
      }

      .log-drawer summary {
        cursor: pointer;
        font-weight: 700;
      }

      .log-drawer[open] summary {
        margin-bottom: 12px;
      }

      .log-help {
        color: var(--muted);
        margin-bottom: 12px;
      }

      .log-output {
        margin: 0;
        max-height: 260px;
        overflow: auto;
        padding: 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: #1e1713;
        color: #f7efe4;
        font-family: Consolas, 'Cascadia Mono', monospace;
        font-size: 0.9rem;
        line-height: 1.45;
        white-space: pre-wrap;
      }

      @media (max-width: 720px) {
        main { width: min(100vw - 20px, 1120px); padding-top: 20px; }
        .hero, .toolbar, .active-banner, .waiting-card, .player-shell, .log-drawer { padding: 18px; border-radius: 20px; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-row">
          <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
          <span class="status-pill">${escapeHtml(input.status)}</span>
        </div>
        <h1>${escapeHtml(input.headline)}</h1>
        <p>${escapeHtml(input.summary)}</p>
      </section>
      ${input.content}
      <details class="log-drawer">
        <summary>Server log</summary>
        <p class="log-help">Live server events for disc scans, session startup, and stream lifecycle.</p>
        <pre id="server-log-output" class="log-output">Loading server log...</pre>
      </details>
      <script>
        const logOutput = document.getElementById('server-log-output')
        const logDrawer = document.querySelector('.log-drawer')
        const logDrawerStorageKey = 'vlc-dvd-streamer:server-log-open'
        const playerStatus = document.getElementById('player-status')

        function saveLogDrawerState() {
          if (!logDrawer) {
            return
          }

          try {
            localStorage.setItem(logDrawerStorageKey, logDrawer.open ? '1' : '0')
          } catch {
          }
        }

        function restoreLogDrawerState() {
          if (!logDrawer) {
            return
          }

          try {
            const savedState = localStorage.getItem(logDrawerStorageKey)
            if (savedState === '1') {
              logDrawer.open = true
            }
            if (savedState === '0') {
              logDrawer.open = false
            }
          } catch {
          }

          logDrawer.addEventListener('toggle', saveLogDrawerState)
          window.addEventListener('beforeunload', saveLogDrawerState)
        }

        function formatLogEntry(entry) {
          if (!entry || typeof entry !== 'object') {
            return ''
          }

          const timestamp = typeof entry.at === 'string' ? new Date(entry.at) : null
          const timeLabel = timestamp && !Number.isNaN(timestamp.getTime())
            ? timestamp.toLocaleTimeString()
            : '--:--:--'
          const level = typeof entry.level === 'string' ? entry.level.toUpperCase() : 'INFO'
          const scope = typeof entry.scope === 'string' ? entry.scope : 'server'
          const message = typeof entry.message === 'string' ? entry.message : ''

          return '[' + timeLabel + '] [' + level + '] [' + scope + '] ' + message
        }

        function replaceLogLines(entries) {
          if (!logOutput) {
            return
          }

          const lines = Array.isArray(entries)
            ? entries.map(formatLogEntry).filter(Boolean)
            : []

          logOutput.textContent = lines.length > 0
            ? lines.join('\\n')
            : 'No server log entries yet.'
          logOutput.scrollTop = logOutput.scrollHeight
        }

        function appendLogEntry(entry) {
          if (!logOutput) {
            return
          }

          const nextLine = formatLogEntry(entry)
          if (!nextLine) {
            return
          }

          const existingLines = logOutput.textContent && logOutput.textContent !== 'No server log entries yet.'
            ? logOutput.textContent.split('\\n').filter(Boolean)
            : []

          existingLines.push(nextLine)
          logOutput.textContent = existingLines.slice(-200).join('\\n')
          logOutput.scrollTop = logOutput.scrollHeight
        }

        function describeRecoveryEvent(payload) {
          if (!payload || typeof payload !== 'object') {
            return ''
          }

          if (payload.status === 'recovering') {
            return 'Unreadable DVD area detected. Skipping ahead while the server rebuilds the stream.'
          }

          if (payload.status === 'idle' && typeof payload.skippedSeconds === 'number' && payload.skippedSeconds > 0) {
            return 'Recovered playback after skipping ' + payload.skippedSeconds + ' seconds of unreadable DVD data.'
          }

          if (payload.status === 'exhausted') {
            return 'Playback stopped because the DVD stayed unreadable after repeated skip attempts.'
          }

          return ''
        }

        async function loadServerLogs() {
          if (!logOutput) {
            return
          }

          try {
            const response = await fetch('/api/logs')
            if (!response.ok) {
              throw new Error('Could not load logs.')
            }

            replaceLogLines(await response.json())
          } catch (error) {
            logOutput.textContent = 'Could not load server log.'
          }
        }

        function connectServerLogStream() {
          if (!logOutput) {
            return
          }

          const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
          const socket = new WebSocket(protocol + '://' + window.location.host + '/ws')

          socket.addEventListener('message', (messageEvent) => {
            let event
            try {
              event = JSON.parse(messageEvent.data)
            } catch {
              return
            }

            if (!event || typeof event.type !== 'string') {
              return
            }

            if (event.type === 'server.log') {
              appendLogEntry(event.payload)
              return
            }

            if (event.type === 'session.recovery') {
              const recoveryText = describeRecoveryEvent(event.payload)
              if (playerStatus && recoveryText) {
                playerStatus.textContent = recoveryText
              }
              window.dispatchEvent(new CustomEvent('vlc-dvd-streamer:session-recovery', { detail: event.payload }))
              return
            }

            if (event.type === 'catalog.updated' && window.location.pathname === '/') {
              const payload = event.payload
              if (payload && typeof payload.state === 'string' && payload.state !== 'empty' && payload.state !== 'no_drive') {
                window.location.reload()
              }
            }
          })
        }

        restoreLogDrawerState()
        void loadServerLogs()
        connectServerLogStream()
      </script>
    </main>
  </body>
</html>`
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }

  return `${seconds}s`
}

function formatClock(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}