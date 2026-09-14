# Browser playback module research

Date: 2026-09-14

## Decision

Move player behavior out of the rendered HTML and into two typed browser modules:

- `src/ui/browser-playback.ts` owns media attachment, timeline display, explicit seek coordination, recovery display, and disposal.
- `src/ui/browser-events.ts` owns the browser's shared WebSocket and exposes a subscription API. The player and log drawer subscribe independently, so playback no longer depends on log UI behavior.

Keep the existing native-HLS preference for Safari and the hls.js fallback elsewhere. hls.js documents `isSupported`, `loadSource`, `attachMedia`, `startLoad`, `recoverMediaError`, and `destroy` on its core player class; its constructor attaches an instance to one media element. That is a good fit for one initializer and one disposer per rendered player. See the [hls.js Hls class reference](https://hlsjs.video-dev.org/api-docs/hls.js.hls).

The page's HTML and CSS remain visually unchanged. The server renders the same controls and adds only browser-module script references plus the raw session manifest identity needed to distinguish a server region from a display URL carrying `videoOnly=1`.

## Build and serving path

The existing `tsc` build already includes `src/**/*.ts` and emits ESM under `dist`. The UI routes therefore serve an allowlisted adjacent file for each browser asset:

- Source execution through `tsx`: read `src/ui/*.ts` and remove erasable type syntax with `node:module.stripTypeScriptTypes` in `strip` mode.
- Compiled execution: read `dist/src/ui/*.js`, emitted by the existing `tsc` command, and serve it directly.

The pure clock formatter is shared with server rendering at `src/shared/format-clock.ts` and explicitly served at `/shared/format-clock.js`; browser relative imports resolve to that route.

This avoids a browser bundler, a runtime TypeScript dependency, generated source strings, and a second asset build. `stripTypeScriptTypes` was added in Node 22.13.0, so the package declares `node >=22.13.0`. Node describes strip mode as type removal without transformation and warns that the API/output is still under active development; browser modules must therefore stay within erasable TypeScript syntax. Production output does not call the stripper. See the [Node 22.14 module API](https://nodejs.org/download/release/v22.14.0/docs/api/module.html#modules-typescript) and the [`stripTypeScriptTypes` reference](https://nodejs.org/download/release/v22.14.0/docs/api/module.html#modulestriptypescripttypescode-options).

The routes are explicit (`/assets/browser-events.js` and `/assets/browser-playback.js`) rather than a general static-file mount. A relative import from playback to `./browser-events.js` resolves through the second allowlisted route in either execution mode.

## Playback behavior contract

The browser keeps two manifest values. The playback URL may carry browser-only flags such as `videoOnly=1`; the raw session manifest URL is the server region identity. Every accepted seek response replaces the raw identity from `result.session.manifestUrl`, then reapplies `videoOnly` to the playback URL if needed.

An explicit seek follows these rules:

1. A target in the current media buffer seeks by assigning `HTMLMediaElement.currentTime` when no server mutation is pending. MDN specifies that assigning `currentTime` seeks the media and that unavailable portions of a live stream may no longer be seekable. See [MDN `currentTime`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime).
2. An unbuffered target is sent to the session seek endpoint. Response tokens ensure that a late older response cannot replace a newer browser intent.
3. While a remote seek is pending, even a buffered-looking later intent is sent to the server. This gives the serialized server a final request matching the browser's final intent; otherwise the ignored older response could still leave the server on its region.
4. A latest `restarted` response reloads its returned manifest. A latest `already-available` response seeks locally only when its raw manifest identity matches the browser's current region. If the server reports a different region, the browser reloads it and converts the title target to media-relative time (`target - regionStart`).
5. A failed seek may already have changed the server region. Fetch the current session and adopt a changed region before waiting for recovery. Both the response and reconciliation retain the latest-intent and disposal guards; a stale failure cannot overwrite a newer seek.

Recovery events are observations of the current server region. The player accepts one only when the session id, raw manifest URL, and timeline start all match its current state. A matching event updates recovery epoch/status without changing the source, anchor, or media time. An old-region recovery snapshot is ignored.

The initializer owns its lifecycle. An `AbortController` removes DOM listeners and aborts outstanding fetches; a disposed guard protects continuations after dynamic imports and response parsing. `pagehide` destroys hls.js and unsubscribes from browser events. Native HLS disposal pauses the element, removes `src`, and calls `load()` to release its resource. The shared event transport closes its WebSocket when its final subscriber leaves and uses socket identity in the close callback so a delayed close cannot clear a newer connection. The relevant platform primitives are documented by [MDN AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController), [MDN `HTMLMediaElement.load()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load), and the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch).

For back/forward-cache restoration, a persisted `pagehide` saves the media offset and region identity in session storage. A persisted `pageshow` reloads the page, restoring all subscriptions and reconciling with current server state. The fresh player consumes the saved offset only if the manifest identity and region start still match. Storage failure falls back to starting at the current region; this deliberate reload trades retained media buffers for one reliable initialization path.

Fatal native-media and hls.js errors expose a useful message and a Retry playback control. Existing bounded automatic decoder/network recovery remains available. Manual retry reconciles the session, replaces the media attachment, and retains the media position only when the region still matches. Attachment generations prevent a delayed import from creating a second player after retry or disposal.

## Verification

Unit coverage checks that rendered pages reference external modules, preserve both manifest identities, do not construct a log-owned WebSocket, and serve type-stripped JavaScript assets with the expected content type.

The synthetic-HLS Playwright suite exercises:

- advancing browser playback and the existing server seek path;
- recovery status without source reload or time reset;
- two seeks completed out of order, including `videoOnly` retention;
- a locally buffered-looking final intent while a remote mutation is pending;
- an `already-available` response whose server region differs from the browser region;
- hls.js destruction and shared event-socket closure on page exit.

Playwright's `page.routeWebSocket` intercepts sockets created after registration, while `WebSocketRoute` can send mock server messages and observe closure. These hooks let the tests exercise the real browser modules without coupling them to the server log drawer. See [Playwright `page.routeWebSocket`](https://playwright.dev/docs/api/class-page#page-route-web-socket) and [WebSocketRoute](https://playwright.dev/docs/api/class-websocketroute).

## Risks

- Source-mode asset serving depends on an active-development Node API and prints an experimental warning on Node 22. Compiled production serving is ordinary JavaScript and avoids this path.
- Browser modules cannot introduce TypeScript syntax that requires transformation, such as enums, without changing the serving strategy. Typechecking plus the asset-route test catches the current class of failures.
- Recovery snapshots intentionally do not move playback. If a future server recovery changes region identity or the timeline anchor, it must be modeled as a distinct region transition rather than silently extending this observational event.
- Request tokens prevent stale browser application, while the pending-mutation rule ensures the server eventually receives the final user intent. The server must continue serializing session mutations for this contract to hold.
