# Recovery timing and playback evidence

## Findings before implementation

Node timers do not guarantee exact callback timing or ordering. Deadline semantics therefore need to be checked when a wakeup runs, independently of how long the event loop and filesystem took. Tests that require a 90ms simulated heal to beat a 400ms patience window are measuring machine scheduling as well as recovery policy. [Node 22 timers](https://nodejs.org/download/release/v22.18.0/docs/api/timers.html#settimeoutcallback-delay-args)

Elapsed measurements require a monotonic clock, while user-visible timestamps require calendar time. High Resolution Time distinguishes these purposes and specifies independence from system/user clock adjustment. Node performance.now provides a process-relative millisecond timestamp. Our inference: pair elapsed reads and cancellable scheduling behind one playback-specific dependency, with production and manual test adapters. [High Resolution Time](https://www.w3.org/TR/hr-time-3/), [Node performance.now](https://nodejs.org/api/perf_hooks.html#performancenow)

HTML media buffered is a set of ranges, and playback advances from currentTime at playbackRate when playing. A furthest buffered endpoint beyond a gap cannot be treated as immediately playable content. Our inference: report only the range containing the playhead; account for paused state, playback rate, receipt age and playback-region identity on the server. [HTML media standard](https://html.spec.whatwg.org/multipage/media.html)

HLS publication must preserve append-only EVENT entries and make manifest changes atomic. VLC closes segments and publishes its index through livehttp. First-publication-wins preserves advertised bytes, but makes an early placeholder irreversible. A deterministic probe through SessionManager proved readable slot 2 existed at worker stop while the placeholder was already advertised. Our inference: recovery must close the old producer and collect its final committed output before deciding which slot remains missing. [RFC 8216 section 6.2.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.1), [VLC 3.0 livehttp](https://github.com/videolan/vlc/blob/3.0.x/modules/access_output/livehttp.c)

## Scope and acceptance

The recovery owner concentrates ordering, retry budgets and commitment. A pure timeout helper alone would leave the race in its caller. Local publication-read errors must remain distinguishable from a missing segment. Stop/seek intent must invalidate an uncommitted recovery decision. Deterministic tests exercise these orderings through the Playback session interface.

Browser feedback is advisory and short-lived. It must not extend patience without bound, revive stopped sessions, or let a report/download from an archived region steer the current region. Missing feedback preserves fallback behavior. We do not infer DVD hardware reliability from synthetic workers or browser doubles.
