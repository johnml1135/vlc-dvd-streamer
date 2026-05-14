---
name: fastify-architecture-clean-code
description: Use when changing Fastify routes, plugins, services, VLC/catalog/session boundaries, app factory wiring, or tests in this repo where architecture, clean code, dependency direction, lifecycle ownership, or testability decisions matter.
---

# Fastify Architecture Clean Code

## Core Principle

Keep HTTP, process startup, domain state, and VLC process control in separate places. Fastify should compose feature modules and translate HTTP requests; services should own business state and lifecycle; the VLC worker should remain the external-process boundary.

## Sources Considered

- Fastify Plugins Guide: https://fastify.dev/docs/latest/Guides/Plugins-Guide/
- Fastify Encapsulation Reference: https://fastify.dev/docs/latest/Reference/Encapsulation/
- Fastify Testing Guide: https://fastify.dev/docs/latest/Guides/Testing/
- Fastify Decorators Reference: https://fastify.dev/docs/latest/Reference/Decorators/
- Clean Architecture and SOLID principles, Robert C. Martin
- Dependency Injection Principles, Practices, and Patterns, Mark Seemann and Steven van Deursen
- Node.js service boundary practice: separate app factories from process entrypoints, inject external adapters, keep modules cohesive

## Repository Shape

- `src/server.ts` owns process startup: environment/config loading, filesystem directory creation, VLC discovery, concrete service construction, timers, logging sinks, and `app.listen()`.
- `src/app.ts` owns the Fastify app factory: plugin registration, route composition, HTTP validation/translation, response codes, `app.inject()` testability, and Fastify close hooks.
- `src/disc/catalog-service.ts` owns catalog state, refresh concurrency, title filtering, and catalog snapshots.
- `src/session/session-manager.ts` owns playback session state, active session replacement, HLS output directory lifecycle, readiness waiting, inactivity cleanup, and process handle shutdown.
- `src/vlc/*` owns VLC command construction, process supervision, scan parsing, transport stream normalization, and worker operations. It must not know about Fastify routes.
- `src/ui/page.ts` should stay rendering-focused and avoid service, filesystem, or process startup decisions.
- Tests should prefer injected services, fake workers, `test/fixtures/fake-vlc.ts`, and Fastify `app.inject()` before using a real listener or real VLC.

## Module Boundary Rules

- Add or change feature behavior inside the feature module that owns the concept: catalog logic in `disc`, playback/session logic in `session`, process command logic in `vlc`, route translation in `app` or a route plugin module.
- When a route group grows, extract a cohesive Fastify plugin such as `registerCatalogRoutes(app, deps)` or `registerSessionRoutes(app, deps)`. Register it from `buildApp` with explicit dependencies.
- Use Fastify encapsulation deliberately: `app.register()` is right for a route group with a prefix, scoped hooks, scoped decorators, or scoped plugins. Shared cross-cutting dependencies should usually remain explicit injected options, not hidden global Fastify decorations.
- Use `fastify-plugin` only when intentionally breaking encapsulation for a root-level capability. Treat it as an architectural decision, not a default.
- Keep route modules thin: parse params/body/query, call services, publish events, map service outcomes to HTTP status/HTML/JSON, and return.

## Dependency Direction

- `server.ts` -> concrete adapters/services -> `buildApp`.
- Fastify route modules -> service interfaces/types and pure helpers.
- `disc` and `session` services -> `VlcWorker` capability, logger capability, filesystem paths passed in options.
- `vlc` modules -> Node process/filesystem utilities and VLC command details only; no imports from `app`, `server`, `disc`, `session`, or `ui` unless it is a stable type intentionally shared inward.
- Domain services must not accept Fastify `request` or `reply`, call `app.inject()`, or know HTTP status codes.
- Tests should be able to instantiate services with fake workers and build the app with fake services. If a unit test needs real process startup, the boundary is leaking.

## State And Lifecycle Ownership

- `server.ts` creates long-lived concrete objects and timers. It is responsible for startup-only filesystem preparation and for wiring cleanup hooks.
- `buildApp` may register `onClose` hooks for app-owned cleanup, but it should not start background timers, create production directories, discover VLC, or listen on ports.
- `CatalogService` owns one catalog snapshot and one in-flight refresh. Do not duplicate catalog state in routes or sessions.
- `SessionManager` owns session maps, active-session replacement, HLS output directories, readiness polling, and stopping process handles. Routes should not delete session directories directly.
- `VlcWorker` owns subprocess invocation and typed worker results. Higher layers should not assemble VLC command-line arguments.
- Event publishing belongs at the orchestration edge after state changes; avoid putting websocket or Fastify details into services.

## Clean-Code Checklist

- Start with the smallest module that owns the behavior; avoid broad rewrites in `app.ts` when one service method or route helper is enough.
- Keep dependencies explicit in constructors/options so tests can inject fakes.
- Validate untrusted HTTP input at the route edge; validate domain invariants again in the owning service when the invariant matters outside HTTP.
- Prefer typed request/result shapes over loose records once data crosses a module boundary.
- Keep route error responses consistent through existing helpers such as `sendApiError` or a local equivalent in an extracted module.
- Avoid global mutable state. If state must live longer than one request, name its owner and add close/cleanup behavior.
- Add focused tests at the boundary you changed: service tests for state rules, `buildApp` plus `app.inject()` for route behavior, fake VLC integration for process-boundary behavior.
- Close Fastify apps, sessions, timers, and subprocess handles in tests that create them.

## Refactoring Triggers

- A route group needs its own prefix, hooks, validation, websocket behavior, or more than a few related endpoints.
- `app.ts` repeats catalog/session lookup, parameter parsing, or error mapping across routes.
- A route starts constructing VLC args, touching process handles, managing timers, or owning output directory cleanup.
- A service imports Fastify types, request/reply objects, or web-only helpers.
- A test cannot exercise behavior without a real listener, real VLC, or production filesystem layout.
- A new feature needs both catalog and session state. Add an orchestration function at the HTTP/application edge; do not make catalog and session services depend on each other casually.

## Common Mistakes

- Turning Fastify decorators into a service locator. Decorators are useful for Fastify lifecycle and scoped context; constructor/options injection is clearer for repo services.
- Breaking Fastify encapsulation with `fastify-plugin` because a dependency is hard to reach. Prefer explicit registration options first.
- Adding startup side effects to `buildApp`, which weakens `app.inject()` tests and blurs the app/server split.
- Letting routes mutate request/reply with ad hoc fields. If request-scoped state is needed, use Fastify decorators/hooks with safe initial values.
- Duplicating catalog/session state in route-local variables beyond a single request.
- Making `VlcWorker` aware of HTTP paths, HTML pages, websockets, or Fastify replies.
- Using a real VLC process in ordinary route or service tests when a fake worker or `fake-vlc.ts` profile can cover the behavior.