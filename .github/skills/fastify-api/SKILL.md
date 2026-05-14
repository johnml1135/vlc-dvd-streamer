---
name: fastify-api
description: Use when implementing or modifying Fastify API routes, REST endpoints, form posts, WebSocket events, stream file routes, buildApp(deps), typed service dependencies, schemas, hooks, plugins, or API tests in this repository.
---

# Fastify API Implementation

Use this for API work in this repo's Fastify v5 server, especially `src/app.ts` and any future route/plugin modules registered from `buildApp(deps)`.

## Repo Shape

- Keep `buildApp(deps)` as the testable application factory. Do not start listeners, read process env, or create long-lived runtime state in route modules unless it is passed through `deps` or deliberately created once during app construction.
- Put new service dependencies in the local service dependency type before using them in handlers. Treat missing optional services as `503`, following the existing `catalogService`, `sessionManager`, `vlcWorker`, `eventHub`, and `serverLog` pattern.
- Keep handlers thin: parse/validate request data, call typed services, publish events after state changes, and return the route response.
- Prefer type-only imports for service contracts and local ESM imports with `.js` extensions.

## Route Patterns

- REST JSON routes live under `/api/...`. Return plain objects from async handlers when possible; Fastify will serialize them. Use explicit status codes through `reply.code(...)` only when the status is not the default.
- Form-backed browser actions live under `/actions/...`. They require `@fastify/formbody`; body values arrive as strings, so parse numbers and booleans deliberately before calling services. Successful form actions should redirect to the relevant page.
- Browser HTML routes (`/`, `/player/:sessionId`) should render with `reply.type('text/html').send(...)` and validate route params before touching session state.
- WebSocket routes require `@fastify/websocket` to be registered before routes. Attach `socket` event handlers synchronously, unsubscribe listeners on `close`, and remember that Fastify HTTP hooks run before the socket is established.
- Stream file routes must validate every path segment before joining paths. For `/streams/:sessionId/:asset`, keep `sessionId` and asset allowlists, call `sessionManager.touch(sessionId)`, serve only from the session output directory, set exact content types, and return `404` for missing assets.

## Schemas And Validation

- Add Fastify JSON schemas for new stable API contracts: `body`, `querystring`, `params`, and `response`. Use route generics such as `{ Body, Querystring, Params, Reply }` so handler code does not need broad casts.
- Keep JSON schemas static application code. Never build route schemas from user input.
- Use schema validation for request shape and cheap type constraints; put async service checks, catalog/session existence checks, and authorization-like decisions in `preHandler` or the handler.
- Include response schemas for public JSON APIs when the response shape is stable. They improve serialization and reduce accidental field exposure.
- Use `additionalProperties: false` when extra input or output keys should be rejected or stripped. Be aware Fastify's Ajv defaults can coerce query/form-adjacent values, so still normalize booleans and numbers at the boundary.

## Error Handling

- For expected API failures, use the repo's `sendApiError(reply, statusCode, message, detail?)` shape: `{ message, detail }`.
- Match existing status conventions: `400` for invalid input or stale selection, `404` for missing sessions/assets/titles, `409` for not-ready catalog state, `502` for VLC/playback start failures, and `503` for unavailable dependencies.
- Let unexpected exceptions bubble to Fastify unless the route can produce a better domain error. Throw `Error` instances, not strings or arbitrary objects.
- In async handlers, either return a payload or send through `reply`; avoid doing both. If `reply.send()` happens outside the promise chain, return or await `reply`.
- Do not use `onError` hooks to send replacement responses. Use `setErrorHandler` or route-level error handling for response shaping.

## Lifecycle Hooks

- Request flow: routing, `onRequest`, `preParsing`, parsing, `preValidation`, validation, `preHandler`, handler, `preSerialization`, `onSend`, response, `onResponse`.
- `request.body` is not available in `onRequest` or `preParsing`. Use `preValidation` only for payload preparation before schema validation, and `preHandler` for service-dependent checks after validation.
- Use either async hooks/plugins or callback hooks/plugins, never both in the same function. Async hooks do not receive or call `done`.
- Register hooks before the routes that need them. Hooks are encapsulated by plugin scope except for shutdown behavior.
- Use `onClose` for normal cleanup such as `sessionManager.stopAll()`. Use `preClose` only when active sockets, streams, or server-attached resources must be closed before the server can finish shutting down.

## Plugin Boundaries

- Keep a small route addition in `src/app.ts` if it follows existing nearby patterns. Extract a plain Fastify plugin when a group has its own prefix, hooks, shared schemas, or lifecycle cleanup.
- Register route groups with prefixes such as `/api`, `/actions`, or `/streams` through plain plugins. Do not wrap route-only plugins with `fastify-plugin` if you need `prefix` encapsulation.
- Use `fastify-plugin` only for shared decorators or behavior that must escape plugin encapsulation, and type the decorator access deliberately.
- Register `formbody` before form posts and `websocket` before WebSocket routes. Shared schemas added with `addSchema` are scoped to the plugin tree where they are registered.

## Common Mistakes

- Treating `request.body`, `request.params`, or `request.query` as typed without a schema, route generic, or narrow boundary parser.
- Treating form body values as numbers or booleans without parsing.
- Registering `@fastify/websocket` after routes, or attaching websocket message handlers after an awaited operation.
- Mixing `return value` with `reply.send(value)` in an async handler, causing duplicate-send warnings or discarded responses.
- Calling `done` inside an async hook or async plugin.
- Expecting schemas, decorators, or hooks registered in one plugin scope to affect sibling scopes.
- Serving a stream asset from a joined path before validating the requested asset name.
- Returning `undefined` from async handlers or throwing non-`Error` values.
- Adding global service singletons that bypass `buildApp(deps)` and make tests harder to inject.

## Sources Considered

- Fastify Reference: Routes - https://fastify.dev/docs/latest/Reference/Routes/
- Fastify Reference: Validation and Serialization - https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Fastify Reference: Plugins - https://fastify.dev/docs/latest/Reference/Plugins/
- Fastify Reference: Hooks - https://fastify.dev/docs/latest/Reference/Hooks/
- Fastify Reference: Lifecycle - https://fastify.dev/docs/latest/Reference/Lifecycle/
- Fastify Reference: TypeScript - https://fastify.dev/docs/latest/Reference/TypeScript/
- Fastify Reference: Errors - https://fastify.dev/docs/latest/Reference/Errors/
- @fastify/websocket README - https://github.com/fastify/fastify-websocket