---
name: typescript-quality
description: Use when changing, reviewing, or debugging TypeScript in this Node ESM repo, especially strict types, Fastify routes, VLC process boundaries, worker interfaces, or Vitest tests
---

# TypeScript Quality

## When to Use

Use this skill for TypeScript implementation, refactoring, debugging, or review in this repository. It is especially relevant when code touches Node 22 ESM behavior, `tsconfig.json`, Fastify route types, VLC process supervision, worker/session interfaces, config parsing, filesystem paths, async cleanup, or Vitest coverage.

## Repo Baseline

- Runtime: Node 22. Do not use APIs that are newer than the supported Node line.
- Module system: `package.json` has `"type": "module"`; TypeScript uses `module` and `moduleResolution` `NodeNext`.
- Source style: relative TypeScript imports should use emitted JavaScript specifiers such as `./worker.js`; built-ins should use `node:` specifiers.
- Type stance: `strict` is enabled. Treat compiler errors as design feedback, not obstacles to cast away.
- Test stack: Vitest for unit/integration, Playwright for browser flows, fake VLC fixtures for process-facing behavior.

## Core Principles

- Model runtime boundaries explicitly. HTTP input, environment variables, filesystem state, VLC stdout/stderr, process exits, and browser playback state are untrusted until parsed or checked.
- Prefer small domain types near the behavior they protect. `SessionState`, `CompletedProcess`, and worker request/response shapes are examples to extend rather than bypass.
- Keep process ownership visible. Code that starts VLC must also define timeout, termination, stderr/stdout capture, and cleanup behavior.
- Use TypeScript to remove states, not to decorate JavaScript. Narrow unions, parse external data, and return explicit result shapes instead of throwing strings or returning partial objects.
- Preserve ESM runtime truth. If it typechecks but would not resolve after `tsc`, it is not correct.

## Patterns to Prefer

- Use `import type` for type-only imports and normal imports only for values that must exist at runtime.
- Use discriminated unions for finite states and outcomes, especially sessions, scan results, process completion, and readiness failures.
- Use `unknown` at external boundaries, then narrow with small helpers before constructing typed objects.
- Use `satisfies` for config maps, literal route metadata, and lookup tables when you want shape checking without widening away useful literals.
- Keep interfaces at module boundaries: worker options, process handles, catalog records, API response payloads, and logger contracts.
- Prefer dependency injection over global state for filesystem paths, clocks, timeouts, VLC workers, loggers, and child process handles.
- In Fastify routes, type request params/query/body/reply where the route uses them. Keep runtime validation and TypeScript types aligned; generics are not validation.
- In error handling, keep caught values as `unknown` until narrowed. Preserve useful detail from `Error`, VLC stderr, exit code, signal, and timeout status.
- In async code, return `Promise<T>` from boundary methods and make cleanup idempotent.

## Patterns to Avoid

- Do not use `any`, broad `as` assertions, non-null assertions, or `// @ts-ignore` to quiet the compiler unless there is a documented unavoidable interop edge.
- Do not add extensionless relative imports, `.ts` import specifiers, or CommonJS `require` in ESM modules unless the surrounding config and runtime path explicitly require it.
- Avoid TypeScript features with runtime emit when a plain JavaScript construct is clearer: prefer unions/objects over `enum`, avoid runtime `namespace`, and avoid parameter properties.
- Avoid path aliases unless package subpath imports or runtime resolution are also configured. Node does not honor `tsconfig` `paths` by itself.
- Do not let Fastify handler types drift from serialized response shapes or route schemas.
- Do not leak raw child process details across higher-level session/catalog APIs when a typed handle or result object can isolate the boundary.

## Review Checklist

- ESM: every relative import resolves under NodeNext after emit; Node built-ins use `node:`; CommonJS interop is intentional.
- Strictness: no new `any`, unsafe casts, non-null assertions, or swallowed `unknown` catch values.
- Boundaries: env/config, HTTP input, disc scan output, filesystem checks, VLC command output, and process exits are parsed before trust.
- Domain shape: state machines and result objects represent failure, timeout, stopped, and cleanup cases explicitly.
- Fastify: route generics, schemas, status codes, and payloads agree; handlers do not rely on unchecked `request.body` or `request.query` shapes.
- Process lifecycle: spawned work has timeout handling, graceful stop, hard-kill fallback where needed, stdout/stderr capture, and deterministic cleanup.
- Tests: changed behavior has focused Vitest coverage; process-facing code uses fake VLC or injected handles; browser playback changes include relevant Playwright coverage.
- Build: run `npm run typecheck` for TypeScript changes and the narrowest relevant `vitest run` target before claiming completion.

## Testing Implications

- Add or update unit tests for pure parsing, narrowing, argument building, MRL construction, and state transitions.
- Add integration tests when API routes, session lifecycle, catalog persistence, HLS readiness, or filesystem cleanup changes.
- Prefer fake VLC fixtures and injected process handles to real VLC in automated tests.
- Make timeout and clock behavior injectable or short enough for tests without making production behavior brittle.
- Assert failure modes, not only happy paths: bad disc scan output, missing manifest, process exit before readiness, stderr detail, repeated stop calls, and cleanup after errors.
- Keep tests behavior-first. Avoid asserting private implementation details when public state, response body, log event, or process result proves the contract.

## Common Mistakes

- Using a cast where a parser or guard belongs, especially for `process.env`, request payloads, JSON, and VLC output.
- Importing `./module` instead of `./module.js` in a NodeNext ESM TypeScript file.
- Importing a type as a value, then getting runtime failures under Node type stripping or ESM execution.
- Treating Fastify route generics as runtime validation.
- Hiding a process failure by returning only `false` or a generic message while discarding stderr, exit code, signal, or timeout status.
- Introducing top-level side effects that start servers, spawn VLC, or touch the filesystem during import, making tests and tools fragile.
- Adding broad shared abstractions before two or three real call sites prove the shape.

## Sources Considered

- TypeScript Handbook: https://www.typescriptlang.org/docs/handbook/intro.html
- TypeScript TSConfig Reference: https://www.typescriptlang.org/tsconfig/
- Node.js 22 TypeScript docs: https://nodejs.org/download/release/v22.21.1/docs/api/typescript.html
- Node.js 22 ECMAScript Modules docs: https://nodejs.org/download/release/v22.21.1/docs/api/esm.html
- Fastify TypeScript Reference: https://fastify.dev/docs/latest/Reference/TypeScript/
- Vitest Guide: https://vitest.dev/guide/