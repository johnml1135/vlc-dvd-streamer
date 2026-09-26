import { subscribeAppEvents, type BrowserAppEvent } from './browser-events.js'
import { formatClock } from '../shared/format-clock.js'

interface TimelineRangeSnapshot {
  startSeconds: number
  endSeconds: number
}

interface TimelineSnapshot {
  currentRange: TimelineRangeSnapshot
}

interface RecoverySnapshot {
  epoch: number
}

interface BrowserPlaybackSession {
  id: string
  manifestUrl: string
  timeline?: TimelineSnapshot
  recovery?: RecoverySnapshot
}

interface SeekSuccess {
  action: 'already-available' | 'restarted'
  positionSeconds: number
  session: BrowserPlaybackSession
}

interface RecoveryEventPayload {
  sessionId: string
  status?: string
  skippedSeconds?: number
  message?: string
  session?: BrowserPlaybackSession
}

interface PlaybackReportSnapshot {
  revision: number
  positionSeconds: number
  bufferedEndSeconds: number
  paused: boolean
  playbackRate: number
}

type HlsConstructor = typeof import('hls.js').default
type HlsInstance = InstanceType<HlsConstructor>

export function initializeBrowserPlayback(root: Document = document): () => void {
  const videoElement = root.getElementById('player') as HTMLVideoElement | null
  const statusElement = root.getElementById('player-status')
  const retryButton = root.getElementById('retry-playback') as HTMLButtonElement | null
  const playerContent = root.getElementById('player-content') as HTMLElement | null
  const viewerPassive = root.getElementById('viewer-passive') as HTMLElement | null
  const viewerStatus = root.getElementById('viewer-status')
  const takeOverViewer = root.getElementById('take-over-viewer') as HTMLButtonElement | null
  const stopStreamForm = root.getElementById('stop-stream-form') as HTMLElement | null
  const seekControl = root.getElementById('title-seek') as HTMLInputElement | null
  const titleCurrentTime = root.getElementById('title-current-time')
  const bufferedSummary = root.getElementById('title-buffered-summary')
  const initialManifestUrl = videoElement?.dataset.manifestUrl
  const activeSessionId = videoElement?.dataset.sessionId

  if (!videoElement || !statusElement || !initialManifestUrl || !activeSessionId) {
    return () => {}
  }

  const video = videoElement
  const status = statusElement
  const manifestUrl = initialManifestUrl
  const sessionId = activeSessionId
  // A reload renders a fresh server token while this tab's previous token may
  // still own the session, so a tab keeps one identity across reloads.
  const viewerTokenKey = 'viewer-token:' + sessionId
  const serverViewerToken = video.dataset.viewerToken || ''
  const renderedActive = video.dataset.viewerActive === 'true'
  const viewerToken = renderedActive ? serverViewerToken : (readTabViewerToken(viewerTokenKey) || serverViewerToken)
  storeTabViewerToken(viewerTokenKey, viewerToken)

  const durationSeconds = Number(video.dataset.durationSeconds || '0')
  let epochStartSeconds = Number(video.dataset.epochStartSeconds || '0')
  let activeRecoveryEpoch = Number(video.dataset.recoveryEpoch || '0')
  let activeSessionManifestUrl = video.dataset.sessionManifestUrl || manifestUrl
  let playbackManifestUrl = manifestUrl
  let activeHls: HlsInstance | null = null
  let nativeHlsActive = false
  let shouldResetPlaybackToZero = true
  let resetMediaTimeSeconds = 0
  let latestSeekRequest = 0
  let pendingRemoteSeeks = 0
  let disposed = false
  let viewerActive = renderedActive
  let hasEverOwned = viewerActive
  let ownershipRequest = 0
  let viewerUnavailable = false
  let viewerHeartbeat: ReturnType<typeof setInterval> | null = null
  let attachmentGeneration = 0
  let retrying = false
  let playbackReportRevision = 0
  let playbackSourceReady = false
  let playbackReportSequence = 0
  let lastPlaybackReportAt = Number.NEGATIVE_INFINITY
  let queuedPlaybackReport: PlaybackReportSnapshot | null = null
  let playbackReportInFlight = false
  let playbackReportController: AbortController | null = null
  let playbackReportTimer: ReturnType<typeof setTimeout> | null = null
  let playbackReportTimeout: ReturnType<typeof setTimeout> | null = null
  let playbackHeartbeat: ReturnType<typeof setInterval> | null = null
  let expectedNativeSourceUrl = ''
  let hlsManifestReady = false
  const playbackReporterId = createPlaybackReporterId()
  const lifecycle = new AbortController()
  const resumeKey = 'playback-resume:' + sessionId
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(resumeKey) || 'null')
    sessionStorage.removeItem(resumeKey)
    if (saved && typeof saved === 'object' && 'manifestUrl' in saved && saved.manifestUrl === activeSessionManifestUrl
      && 'startSeconds' in saved && saved.startSeconds === epochStartSeconds
      && 'mediaTime' in saved && typeof saved.mediaTime === 'number' && Number.isFinite(saved.mediaTime)) {
      resetMediaTimeSeconds = Math.max(0, saved.mediaTime)
    }
  } catch {
    // Playback still starts normally when storage is unavailable.
  }

  function currentTitleSeconds(): number {
    return epochStartSeconds + video.currentTime
  }

  function isTitleTimeBuffered(titleSeconds: number): boolean {
    if (!Number.isFinite(titleSeconds)) {
      return false
    }

    for (let index = 0; index < video.buffered.length; index += 1) {
      const startSeconds = epochStartSeconds + video.buffered.start(index)
      const endSeconds = epochStartSeconds + video.buffered.end(index)
      if (titleSeconds >= startSeconds && titleSeconds < endSeconds) {
        return true
      }
    }

    return false
  }

  function boundedTitleSeconds(value: number): number {
    if (!Number.isFinite(value)) {
      return 0
    }

    const upperBound = durationSeconds > 0 && Number.isFinite(durationSeconds)
      ? durationSeconds
      : Number.POSITIVE_INFINITY
    return Math.min(upperBound, Math.max(0, value))
  }

  function playbackReportSnapshot(): PlaybackReportSnapshot | null {
    if (disposed || !viewerActive || !playbackSourceReady || shouldResetPlaybackToZero || pendingRemoteSeeks > 0) {
      return null
    }

    const positionSeconds = boundedTitleSeconds(currentTitleSeconds())
    const currentTime = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0
    let bufferedEndSeconds = positionSeconds
    for (let index = 0; index < video.buffered.length; index += 1) {
      const startSeconds = video.buffered.start(index)
      const endSeconds = video.buffered.end(index)
      if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds)
        && currentTime >= startSeconds && currentTime <= endSeconds) {
        bufferedEndSeconds = boundedTitleSeconds(epochStartSeconds + endSeconds)
        break
      }
    }

    const playbackRate = Number.isFinite(video.playbackRate) && video.playbackRate >= 0 && video.playbackRate <= 16
      ? video.playbackRate
      : 1
    return {
      revision: playbackReportRevision,
      positionSeconds,
      bufferedEndSeconds,
      paused: Boolean(video.paused),
      playbackRate,
    }
  }

  function clearPlaybackReportTimer(): void {
    if (playbackReportTimer !== null) {
      clearTimeout(playbackReportTimer)
      playbackReportTimer = null
    }
  }

  function flushPlaybackReport(): void {
    if (disposed || !viewerActive || playbackReportInFlight || !queuedPlaybackReport) {
      return
    }

    const queuedRevision = queuedPlaybackReport.revision
    if (queuedRevision !== playbackReportRevision || shouldResetPlaybackToZero || pendingRemoteSeeks > 0) {
      queuedPlaybackReport = null
      return
    }

    const elapsed = performance.now() - lastPlaybackReportAt
    if (elapsed < 1000) {
      clearPlaybackReportTimer()
      playbackReportTimer = setTimeout(() => {
        playbackReportTimer = null
        flushPlaybackReport()
      }, Math.max(0, 1000 - elapsed))
      return
    }

    const snapshot = playbackReportSnapshot()
    if (!snapshot || snapshot.revision !== queuedRevision) {
      queuedPlaybackReport = null
      return
    }

    queuedPlaybackReport = null
    const sequence = ++playbackReportSequence
    lastPlaybackReportAt = performance.now()
    playbackReportInFlight = true
    const controller = new AbortController()
    playbackReportController = controller
    playbackReportTimeout = setTimeout(() => controller.abort(), 2000)
    void fetch(`/api/sessions/${sessionId}/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewerToken,
        manifestUrl: activeSessionManifestUrl,
        reporterId: playbackReporterId,
        sequence,
        positionSeconds: snapshot.positionSeconds,
        bufferedEndSeconds: snapshot.bufferedEndSeconds,
        paused: snapshot.paused,
        playbackRate: snapshot.playbackRate,
      }),
      signal: controller.signal,
    }).catch(() => {
      // Reporting is best effort and must never affect playback recovery.
    }).finally(() => {
      if (playbackReportTimeout !== null) {
        clearTimeout(playbackReportTimeout)
        playbackReportTimeout = null
      }
      if (playbackReportController === controller) {
        playbackReportController = null
      }
      playbackReportInFlight = false
      flushPlaybackReport()
    })
  }

  function queuePlaybackReport(): void {
    const snapshot = playbackReportSnapshot()
    if (!snapshot) {
      return
    }

    queuedPlaybackReport = snapshot
    flushPlaybackReport()
  }

  function invalidatePlaybackReports(): void {
    playbackReportRevision += 1
    playbackSourceReady = false
    hlsManifestReady = false
    expectedNativeSourceUrl = ''
    queuedPlaybackReport = null
    clearPlaybackReportTimer()
    if (playbackReportTimeout !== null) {
      clearTimeout(playbackReportTimeout)
      playbackReportTimeout = null
    }
    playbackReportController?.abort()
  }

  function updateTimelineUi(): void {
    if (titleCurrentTime) {
      titleCurrentTime.textContent = formatClock(currentTitleSeconds())
    }

    if (seekControl && root.activeElement !== seekControl) {
      seekControl.value = String(Math.min(durationSeconds || currentTitleSeconds(), currentTitleSeconds()))
    }

    if (bufferedSummary) {
      const ranges: string[] = []
      for (let index = 0; index < video.buffered.length; index += 1) {
        ranges.push(`${formatClock(epochStartSeconds + video.buffered.start(index))}-${formatClock(epochStartSeconds + video.buffered.end(index))}`)
      }
      bufferedSummary.textContent = ranges.length > 0
        ? `Buffered: ${ranges.join(', ')}`
        : 'Buffering current title range'
    }
  }

  function applySeekSession(session: BrowserPlaybackSession): void {
    activeSessionManifestUrl = session.manifestUrl
    playbackManifestUrl = preserveStreamFlag(session.manifestUrl, playbackManifestUrl, 'videoOnly')
    video.dataset.sessionManifestUrl = session.manifestUrl
    video.dataset.manifestUrl = playbackManifestUrl
    const startSeconds = session.timeline?.currentRange.startSeconds
    if (typeof startSeconds === 'number') {
      epochStartSeconds = startSeconds
      video.dataset.epochStartSeconds = String(epochStartSeconds)
    }

    const recoveryEpoch = session.recovery?.epoch
    if (typeof recoveryEpoch === 'number' && Number.isFinite(recoveryEpoch)) {
      activeRecoveryEpoch = recoveryEpoch
      video.dataset.recoveryEpoch = String(activeRecoveryEpoch)
    }

    updateTimelineUi()
  }

  function syncRecoveredSession(payload: RecoveryEventPayload): boolean {
    const recoveredSession = payload.session
    if (payload.sessionId !== sessionId || !isBrowserPlaybackSession(recoveredSession) || recoveredSession.id !== sessionId) {
      return false
    }

    const recoveryStart = recoveredSession.timeline?.currentRange.startSeconds
    if (recoveredSession.manifestUrl !== activeSessionManifestUrl || recoveryStart !== epochStartSeconds) {
      return false
    }

    const recoveryEpoch = recoveredSession.recovery?.epoch
    if (typeof recoveryEpoch === 'number' && Number.isFinite(recoveryEpoch)) {
      activeRecoveryEpoch = recoveryEpoch
      video.dataset.recoveryEpoch = String(activeRecoveryEpoch)
    }
    updateTimelineUi()
    return true
  }

  function seekWithinCurrentMedia(titleSeconds: number): void {
    video.currentTime = Math.max(0, titleSeconds - epochStartSeconds)
    updateTimelineUi()
  }

  function reloadPlaybackSource(titleSeconds: number, statusAfterAttach = status.textContent): void {
    invalidatePlaybackReports()
    attachmentGeneration += 1
    resetMediaTimeSeconds = Math.max(0, titleSeconds - epochStartSeconds)
    shouldResetPlaybackToZero = true
    if (activeHls) {
      const hls = activeHls
      activeHls = null
      hls.destroy()
      void attachStream(statusAfterAttach)
      return
    }

    if (nativeHlsActive) {
      expectedNativeSourceUrl = playbackManifestUrl
      video.src = playbackManifestUrl
      video.load()
      return
    }

    void attachStream(statusAfterAttach)
  }

  function mediaResourceIsReady(): boolean {
    if (video.readyState < 1) {
      return false
    }

    if (nativeHlsActive) {
      const currentSource = video.currentSrc || video.src
      if (!expectedNativeSourceUrl || !currentSource) {
        return false
      }
      try {
        return new URL(currentSource, window.location.origin).href
          === new URL(expectedNativeSourceUrl, window.location.origin).href
      } catch {
        return currentSource === expectedNativeSourceUrl
      }
    }

    return activeHls !== null && hlsManifestReady
  }

  function resetPlaybackToWindowStart(markSourceReady = false): void {
    if (!shouldResetPlaybackToZero) {
      if (markSourceReady) {
        playbackSourceReady = true
      }
      return
    }

    try {
      video.currentTime = resetMediaTimeSeconds
      if (markSourceReady) {
        shouldResetPlaybackToZero = false
        playbackSourceReady = true
      }
      updateTimelineUi()
    } catch {
    }
  }

  async function reconcileSession(requestNumber: number): Promise<boolean> {
    try {
      const response = await fetch('/api/sessions/' + sessionId, { signal: lifecycle.signal })
      if (!response.ok) return false
      const session: unknown = await response.json()
      if (disposed || requestNumber !== latestSeekRequest || !isBrowserPlaybackSession(session) || session.id !== sessionId) return false
      const changed = session.manifestUrl !== activeSessionManifestUrl || session.timeline?.currentRange.startSeconds !== epochStartSeconds
      applySeekSession(session)
      if (changed) reloadPlaybackSource(epochStartSeconds)
      return true
    } catch {
      return false
    }
  }

  async function seekTitleTo(titleSeconds: number): Promise<void> {
    if (!viewerActive || !Number.isFinite(titleSeconds)) {
      return
    }

    const requestNumber = ++latestSeekRequest
    if (pendingRemoteSeeks === 0 && isTitleTimeBuffered(titleSeconds)) {
      seekWithinCurrentMedia(titleSeconds)
      status.textContent = 'Playing from the existing buffer.'
      return
    }

    status.textContent = `Seeking to ${formatClock(titleSeconds)} and buffering from the DVD.`
    pendingRemoteSeeks += 1
    try {
      const response = await fetch(`/api/sessions/${sessionId}/seek`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionSeconds: titleSeconds }),
        signal: lifecycle.signal,
      })
      if (disposed || requestNumber !== latestSeekRequest) {
        return
      }
      if (!response.ok) {
        status.textContent = `Could not seek to ${formatClock(titleSeconds)}.`
        await reconcileSession(requestNumber)
        return
      }

      const result: unknown = await response.json()
      if (disposed || requestNumber !== latestSeekRequest || !isSeekSuccess(result) || result.session.id !== sessionId) {
        return
      }

      const regionChanged = result.session.manifestUrl !== activeSessionManifestUrl
      activeSessionManifestUrl = result.session.manifestUrl
      playbackManifestUrl = preserveStreamFlag(result.session.manifestUrl, playbackManifestUrl, 'videoOnly')
      applySeekSession(result.session)
      if (result.action === 'already-available' && !regionChanged) {
        seekWithinCurrentMedia(result.positionSeconds)
        status.textContent = 'Playing from the current HLS window.'
        return
      }

      status.textContent = `Buffering from ${formatClock(result.positionSeconds)}.`
      reloadPlaybackSource(result.positionSeconds, status.textContent)
    } catch {
      if (!disposed && requestNumber === latestSeekRequest) {
        status.textContent = `Could not seek to ${formatClock(titleSeconds)}.`
        await reconcileSession(requestNumber)
      }
    } finally {
      pendingRemoteSeeks -= 1
      if (pendingRemoteSeeks === 0) {
        queuePlaybackReport()
      }
    }
  }

  function showPlaybackError(message: string): void {
    if (disposed) return
    status.textContent = 'Playback failed: ' + message
    if (retryButton) retryButton.hidden = false
  }

  async function retryPlayback(): Promise<void> {
    if (disposed || !viewerActive || retrying) return
    retrying = true
    if (retryButton) retryButton.disabled = true
    const requestNumber = ++latestSeekRequest
    const previousManifest = activeSessionManifestUrl
    const previousStart = epochStartSeconds
    const titleSeconds = currentTitleSeconds()
    await reconcileSession(requestNumber)
    if (disposed || requestNumber !== latestSeekRequest) {
      retrying = false
      if (retryButton) retryButton.disabled = false
      return
    }
    resetMediaTimeSeconds = previousManifest === activeSessionManifestUrl && previousStart === epochStartSeconds
      ? Math.max(0, titleSeconds - epochStartSeconds) : 0
    shouldResetPlaybackToZero = true
    invalidatePlaybackReports()
    attachmentGeneration += 1
    activeHls?.destroy()
    activeHls = null
    if (nativeHlsActive) {
      video.pause()
      video.removeAttribute('src')
      video.load()
      nativeHlsActive = false
    }
    if (retryButton) retryButton.hidden = true
    await attachStream()
    if (!disposed && requestNumber === latestSeekRequest) {
      try {
        await video.play()
      } catch {
        showPlaybackError('Playback could not start. Try again or use the video play control.')
      }
    }
    retrying = false
    if (retryButton) retryButton.disabled = false
  }

  async function attachStream(statusAfterAttach?: string): Promise<void> {
    const generation = ++attachmentGeneration
    expectedNativeSourceUrl = ''
    hlsManifestReady = false
    const userAgent = navigator.userAgent
    const isEmbeddedCodeBrowser = userAgent.includes('Code/')
    const isChromiumBrowser = /Chrom(e|ium)|Edg|OPR|Electron/.test(userAgent) || isEmbeddedCodeBrowser
    const prefersNativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'))
      && /Safari\//.test(userAgent)
      && !isChromiumBrowser
    playbackManifestUrl = isEmbeddedCodeBrowser
      ? appendStreamFlag(playbackManifestUrl, 'videoOnly')
      : playbackManifestUrl

    try {
      const hlsModuleUrl = '/assets/hls.mjs'
      const module = await import(hlsModuleUrl) as { default: HlsConstructor }
      if (disposed || generation !== attachmentGeneration) {
        return
      }
      const Hls = module.default

      if (!prefersNativeHls && Hls?.isSupported()) {
        const hls = new Hls({
          startPosition: 0,
          detectStallWithCurrentTimeMs: 1250,
          highBufferWatchdogPeriod: 2,
          nudgeMaxRetry: 5,
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
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed || generation !== attachmentGeneration || hls !== activeHls) return
          hlsManifestReady = true
          resetPlaybackToWindowStart()
        })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (disposed || hls !== activeHls) return
          if (data.fatal) {
            const category = data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'The video decoder could not continue'
              : data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'The video stream could not be loaded'
                : 'The HLS stream could not continue'
            showPlaybackError(category + (data.details ? ': ' + data.details : '.'))
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && Date.now() - lastMediaRecoveryAt > 5000) {
              lastMediaRecoveryAt = Date.now()
              hls.recoverMediaError()
            } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad(-1)
            }
          } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            status.textContent = 'Waiting for recovered HLS data from the server.'
          }
        })
        hls.loadSource(playbackManifestUrl)
        hls.attachMedia(video)
        status.textContent = statusAfterAttach ?? (isEmbeddedCodeBrowser
          ? 'Using hls.js fallback without audio in the embedded browser.'
          : 'Using hls.js fallback.')
        return
      }
    } catch {
      // Fall through to native HLS or the unsupported-browser message.
    }

    if (disposed || generation !== attachmentGeneration) {
      return
    }

    if (prefersNativeHls) {
      nativeHlsActive = true
      expectedNativeSourceUrl = playbackManifestUrl
      video.src = playbackManifestUrl
      status.textContent = 'Using native HLS support.'
      return
    }

    showPlaybackError('This browser needs native HLS or hls.js support to render the stream.')
  }

  function stopAfterTerminalSession(message: string): void {
    if (disposed) return
    disposed = true
    latestSeekRequest += 1
    lifecycle.abort()
    if (viewerHeartbeat !== null) {
      clearInterval(viewerHeartbeat)
      viewerHeartbeat = null
    }
    if (playbackHeartbeat !== null) {
      clearInterval(playbackHeartbeat)
      playbackHeartbeat = null
    }
    queuedPlaybackReport = null
    clearPlaybackReportTimer()
    if (playbackReportTimeout !== null) {
      clearTimeout(playbackReportTimeout)
      playbackReportTimeout = null
    }
    playbackReportController?.abort()
    unsubscribe()
    activeHls?.destroy()
    activeHls = null
    video.pause()
    video.removeAttribute('src')
    video.load()
    nativeHlsActive = false
    if (retryButton) retryButton.hidden = true
    status.textContent = message
  }

  function updateViewerUi(): void {
    if (playerContent) playerContent.hidden = !viewerActive
    if (viewerPassive) viewerPassive.hidden = viewerActive
    if (stopStreamForm) stopStreamForm.hidden = !viewerActive
    if (viewerActive) {
      if (viewerStatus) viewerStatus.textContent = ''
    } else {
      if (viewerStatus) viewerStatus.textContent = hasEverOwned ? 'Watching elsewhere' : 'Playing on another device'
      if (takeOverViewer) takeOverViewer.textContent = hasEverOwned ? 'Take back' : 'Take over?'
    }
  }

  function setViewerActive(active: boolean): void {
    if (disposed) return
    if (viewerActive === active) {
      updateViewerUi()
      return
    }

    viewerActive = active
    if (active) {
      hasEverOwned = true
      updateViewerUi()
      void attachStream()
      return
    }

    latestSeekRequest += 1
    attachmentGeneration += 1
    invalidatePlaybackReports()
    activeHls?.destroy()
    activeHls = null
    hlsManifestReady = false
    expectedNativeSourceUrl = ''
    nativeHlsActive = false
    video.pause()
    video.removeAttribute('src')
    video.load()
    if (retryButton) retryButton.hidden = true
    updateViewerUi()
  }

  async function refreshViewerOwnership(): Promise<void> {
    const requestNumber = ++ownershipRequest
    try {
      const response = await fetch(`/api/sessions/${sessionId}/viewer/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerToken }),
        signal: lifecycle.signal,
      })
      if (disposed || requestNumber !== ownershipRequest) return
      if (!response.ok) {
        viewerUnavailable = true
        if (viewerHeartbeat !== null) {
          clearInterval(viewerHeartbeat)
          viewerHeartbeat = null
        }
        setViewerActive(false)
        if (viewerStatus) viewerStatus.textContent = 'This Playback session has ended.'
        if (takeOverViewer) takeOverViewer.disabled = true
        return
      }

      const result: unknown = await response.json()
      if (disposed || requestNumber !== ownershipRequest) return
      if (isViewerOwnershipResult(result)) setViewerActive(result.active)
    } catch {
      // Ownership refresh is best effort while the event stream is reconnecting.
    }
  }

  async function takeOverPlayback(): Promise<void> {
    if (disposed || viewerActive) return
    if (takeOverViewer) takeOverViewer.disabled = true
    try {
      const response = await fetch(`/api/sessions/${sessionId}/viewer/takeover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerToken }),
        signal: lifecycle.signal,
      })
      if (disposed) return
      if (!response.ok) {
        if (viewerStatus) viewerStatus.textContent = 'Could not take over this Playback session.'
        return
      }
      const result: unknown = await response.json()
      if (isViewerOwnershipResult(result)) setViewerActive(result.active)
    } catch {
      if (!disposed && viewerStatus) viewerStatus.textContent = 'Could not take over this Playback session.'
    } finally {
      if (!disposed && takeOverViewer) takeOverViewer.disabled = false
    }
  }

  function handleAppEvent(event: BrowserAppEvent): void {
    if (event.type === 'session.updated') {
      const terminalMessage = getTerminalSessionMessage(event.payload, sessionId)
      if (terminalMessage) stopAfterTerminalSession(terminalMessage)
      return
    }

    if (event.type === 'session.viewer' && isViewerEventPayload(event.payload, sessionId)) {
      if (viewerActive) setViewerActive(false)
      void refreshViewerOwnership()
      return
    }
    if (event.type !== 'session.recovery' || !isRecoveryEventPayload(event.payload)) {
      return
    }

    if (syncRecoveredSession(event.payload)) {
      const recoveryText = describeRecoveryEvent(event.payload)
      if (recoveryText) {
        status.textContent = recoveryText
      }
    }
  }

  const unsubscribe = subscribeAppEvents(handleAppEvent)
  updateViewerUi()
  root.addEventListener('visibilitychange', () => {
    if (root.visibilityState === 'visible' && !viewerUnavailable) void refreshViewerOwnership()
  }, { signal: lifecycle.signal })
  takeOverViewer?.addEventListener('click', () => { void takeOverPlayback() }, { signal: lifecycle.signal })
  retryButton?.addEventListener('click', () => { void retryPlayback() }, { signal: lifecycle.signal })
  video.addEventListener('error', () => {
    showPlaybackError(video.error?.message || 'Media error ' + (video.error?.code ?? 'unknown'))
  }, { signal: lifecycle.signal })
  video.addEventListener('timeupdate', updateTimelineUi, { signal: lifecycle.signal })
  video.addEventListener('progress', updateTimelineUi, { signal: lifecycle.signal })
  video.addEventListener('loadedmetadata', () => {
    if (mediaResourceIsReady()) {
      resetPlaybackToWindowStart(true)
    }
  }, { signal: lifecycle.signal })
  video.addEventListener('playing', () => {
    if (mediaResourceIsReady()) {
      resetPlaybackToWindowStart(true)
      queuePlaybackReport()
    }
  }, { signal: lifecycle.signal })
  video.addEventListener('timeupdate', queuePlaybackReport, { signal: lifecycle.signal })
  video.addEventListener('progress', queuePlaybackReport, { signal: lifecycle.signal })
  video.addEventListener('pause', queuePlaybackReport, { signal: lifecycle.signal })
  video.addEventListener('ratechange', queuePlaybackReport, { signal: lifecycle.signal })
  seekControl?.addEventListener('input', () => {
    if (titleCurrentTime) {
      titleCurrentTime.textContent = formatClock(Number(seekControl.value))
    }
  }, { signal: lifecycle.signal })
  seekControl?.addEventListener('change', () => {
    void seekTitleTo(Number(seekControl.value))
  }, { signal: lifecycle.signal })
  if (!viewerActive) void refreshViewerOwnership()
  if (viewerActive) void attachStream()
  playbackHeartbeat = setInterval(queuePlaybackReport, 2000)
  viewerHeartbeat = setInterval(() => {
    if (!viewerUnavailable) void refreshViewerOwnership()
  }, 2000)

  const dispose = (): void => {
    if (disposed) {
      return
    }

    disposed = true
    latestSeekRequest += 1
    lifecycle.abort()
    if (playbackHeartbeat !== null) {
      clearInterval(playbackHeartbeat)
      playbackHeartbeat = null
    }
    if (viewerHeartbeat !== null) clearInterval(viewerHeartbeat)
    queuedPlaybackReport = null
    clearPlaybackReportTimer()
    if (playbackReportTimeout !== null) {
      clearTimeout(playbackReportTimeout)
      playbackReportTimeout = null
    }
    playbackReportController?.abort()
    unsubscribe()
    activeHls?.destroy()
    activeHls = null
    if (nativeHlsActive) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }
  window.addEventListener('pagehide', (event) => {
    void fetch(`/api/sessions/${sessionId}/viewer/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerToken }),
      keepalive: true,
    }).catch(() => {})
    if (event.persisted) {
      try {
        sessionStorage.setItem(resumeKey, JSON.stringify({ manifestUrl: activeSessionManifestUrl, startSeconds: epochStartSeconds, mediaTime: video.currentTime }))
      } catch {
        // A restored page can still restart from its current server region.
      }
    }
    dispose()
  }, { once: true, signal: lifecycle.signal })
  return dispose
}

function isViewerOwnershipResult(value: unknown): value is { active: boolean } {
  return Boolean(value && typeof value === 'object' && 'active' in value && typeof value.active === 'boolean')
}

function readTabViewerToken(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function storeTabViewerToken(key: string, token: string): void {
  if (!token) return
  try {
    sessionStorage.setItem(key, token)
  } catch {
    // Without storage a reload waits for the stale owner to expire.
  }
}

function isViewerEventPayload(value: unknown, sessionId: string): value is { sessionId: string } {
  return Boolean(value && typeof value === 'object' && 'sessionId' in value && value.sessionId === sessionId)
}

function appendStreamFlag(url: string, key: string): string {
  if (hasStreamFlag(url, key)) {
    return url
  }

  return `${url}${url.includes('?') ? '&' : '?'}${key}=1`
}

function hasStreamFlag(url: string, key: string): boolean {
  try {
    return new URL(url, window.location.origin).searchParams.get(key) === '1'
  } catch {
    return false
  }
}

function preserveStreamFlag(nextUrl: string, currentUrl: string, key: string): string {
  return hasStreamFlag(currentUrl, key) ? appendStreamFlag(nextUrl, key) : nextUrl
}

function createPlaybackReporterId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
  }

  return `playback-${Date.now()}-${Math.random().toString(36).slice(2)}`
}


function isSeekSuccess(value: unknown): value is SeekSuccess {
  if (!value || typeof value !== 'object') {
    return false
  }

  return 'action' in value
    && (value.action === 'already-available' || value.action === 'restarted')
    && 'positionSeconds' in value
    && typeof value.positionSeconds === 'number'
    && Number.isFinite(value.positionSeconds)
    && 'session' in value
    && isBrowserPlaybackSession(value.session)
}

function isBrowserPlaybackSession(value: unknown): value is BrowserPlaybackSession {
  if (!value || typeof value !== 'object') {
    return false
  }

  return 'id' in value
    && typeof value.id === 'string'
    && 'manifestUrl' in value
    && typeof value.manifestUrl === 'string'
    && value.manifestUrl.length > 0
    && 'timeline' in value && isTimelineSnapshot(value.timeline)
}

function isTimelineSnapshot(value: unknown): value is TimelineSnapshot {
  if (!value || typeof value !== 'object' || !('currentRange' in value)) return false
  const range = value.currentRange
  return Boolean(range && typeof range === 'object'
    && 'startSeconds' in range && typeof range.startSeconds === 'number' && Number.isFinite(range.startSeconds) && range.startSeconds >= 0
    && 'endSeconds' in range && typeof range.endSeconds === 'number' && Number.isFinite(range.endSeconds) && range.endSeconds >= range.startSeconds)
}

function getTerminalSessionMessage(value: unknown, sessionId: string): string | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as { id?: unknown; sessionId?: unknown; state?: unknown; stopped?: unknown; error?: unknown }
  if (payload.id !== sessionId && payload.sessionId !== sessionId) return null

  if (payload.state === 'failed') {
    const error = payload.error && typeof payload.error === 'object'
      ? (payload.error as { message?: unknown }).message
      : undefined
    const reason = typeof error === 'string' && error.length > 0 ? error : 'The stream could not continue.'
    return 'Playback failed: ' + reason
  }

  if (payload.state === 'stopped' || payload.stopped === true) {
    return 'This playback session ended. Return to titles to start another stream.'
  }

  return null
}
function isRecoveryEventPayload(value: unknown): value is RecoveryEventPayload {
  if (!value || typeof value !== 'object') {
    return false
  }

  return 'sessionId' in value
    && typeof value.sessionId === 'string'
}

function describeRecoveryEvent(payload: RecoveryEventPayload): string {
  if (typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message
  }

  if (payload.status === 'recovering') {
    return 'Unreadable DVD area detected. Skipping ahead while the server rebuilds the stream.'
  }

  if (payload.status === 'idle' && typeof payload.skippedSeconds === 'number' && payload.skippedSeconds > 0) {
    return `Recovered playback after skipping ${payload.skippedSeconds} seconds of unreadable DVD data.`
  }

  if (payload.status === 'exhausted') {
    return 'Playback stopped because the DVD stayed unreadable after repeated skip attempts.'
  }

  return ''
}

if (typeof document !== 'undefined') {
  initializeBrowserPlayback(document)
}
