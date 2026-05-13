# V1 Command Harness First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the repo foundation, command/process harness, fake VLC executable, and browser-test scaffolding that later catalog and streaming features will rely on.

**Architecture:** Create a Fastify app factory with injected dependencies and no process-global singletons. Represent VLC invocations as validated command specs and execute them through a direct `spawn()`-based supervisor with no shell, explicit timeout handling, structured stdout/stderr capture, and predictable shutdown. Prove the boundary first with a fake VLC CLI and sequential integration tests before using real VLC or real discs.

**Tech Stack:** Node.js, TypeScript, Fastify, Vitest, Playwright Test, VLC CLI, `node:child_process`

---

### Task 1: Scaffold the TypeScript and Fastify foundation

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/app.ts`
- Create: `src/server.ts`
- Create: `src/types/env.d.ts`
- Test: `test/unit/app.test.ts`

- [ ] **Step 1: Write the failing app-factory smoke test**

```typescript
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'

describe('buildApp', () => {
  it('creates a Fastify app with a health route placeholder', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
      },
      services: {},
    })

    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/unit/app.test.ts`

Expected: failure because `buildApp` and project scripts do not exist yet.

- [ ] **Step 3: Create the initial project files**

```json
{
  "name": "vlc-dvd-streamer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "fastify": "^5.6.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.58.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "playwright/**/*.ts"]
}
```

```gitignore
node_modules/
dist/
.cache/
playwright-report/
test-results/
coverage/
```

```typescript
import Fastify from 'fastify'

export interface AppDeps {
  config: {
    host: string
    port: number
    cacheDir: string
  }
  services: Record<string, unknown>
}

export async function buildApp(_deps: AppDeps) {
  const app = Fastify()

  app.get('/api/health', async () => ({ ok: true }))

  return app
}
```

```typescript
import { buildApp } from './app'

const app = await buildApp({
  config: {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    cacheDir: process.env.CACHE_DIR ?? '.cache',
  },
  services: {},
})

await app.listen({ host: '127.0.0.1', port: 3000 })
```

- [ ] **Step 4: Run the unit test again**

Run: `npm test -- test/unit/app.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the foundation scaffold**

Run:

```bash
git add package.json tsconfig.json .gitignore src/app.ts src/server.ts src/types/env.d.ts test/unit/app.test.ts
git commit -m "feat: scaffold fastify typescript foundation"
```

### Task 2: Define the VLC command and process supervision contracts

**Files:**
- Create: `src/vlc/command-spec.ts`
- Create: `src/vlc/process-supervisor.ts`
- Create: `src/vlc/process-events.ts`
- Test: `test/unit/vlc/command-spec.test.ts`
- Test: `test/unit/vlc/process-supervisor.test.ts`

- [ ] **Step 1: Write the failing command-spec tests**

```typescript
import { describe, expect, it } from 'vitest'
import { createCommandSpec } from '../../../src/vlc/command-spec'

describe('createCommandSpec', () => {
  it('creates a shell-free executable spec', () => {
    const spec = createCommandSpec({
      executable: 'C:/Program Files/VideoLAN/VLC/vlc.exe',
      args: ['--version'],
      timeoutMs: 5000,
      label: 'vlc-version',
    })

    expect(spec.executable).toContain('vlc.exe')
    expect(spec.args).toEqual(['--version'])
    expect(spec.timeoutMs).toBe(5000)
    expect(spec.shell).toBe(false)
    expect(spec.windowsHide).toBe(true)
  })
})
```

```typescript
import { describe, expect, it } from 'vitest'
import { normalizeExit } from '../../../src/vlc/process-events'

describe('normalizeExit', () => {
  it('keeps exit handling on close-style results', () => {
    expect(normalizeExit({ code: 0, signal: null }).ok).toBe(true)
    expect(normalizeExit({ code: null, signal: 'SIGTERM' }).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/vlc/command-spec.test.ts test/unit/vlc/process-supervisor.test.ts`

Expected: failure because the VLC contract modules do not exist yet.

- [ ] **Step 3: Add the command and supervision types**

```typescript
export interface CommandSpecInput {
  executable: string
  args: string[]
  timeoutMs: number
  label: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface CommandSpec extends CommandSpecInput {
  shell: false
  windowsHide: true
}

export function createCommandSpec(input: CommandSpecInput): CommandSpec {
  return {
    ...input,
    shell: false,
    windowsHide: true,
  }
}
```

```typescript
export interface ExitShape {
  code: number | null
  signal: NodeJS.Signals | null
}

export function normalizeExit(exit: ExitShape) {
  return {
    ok: exit.code === 0,
    code: exit.code,
    signal: exit.signal,
  }
}
```

```typescript
import { spawn } from 'node:child_process'
import type { CommandSpec } from './command-spec'

export interface CompletedProcess {
  ok: boolean
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export async function runManagedProcess(spec: CommandSpec): Promise<CompletedProcess> {
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: spec.shell,
    windowsHide: spec.windowsHide,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString()
  })

  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  return await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => {
      resolve({ ok: code === 0, code, signal, stdout, stderr })
    })
  })
}
```

- [ ] **Step 4: Re-run the unit tests**

Run: `npm test -- test/unit/vlc/command-spec.test.ts test/unit/vlc/process-supervisor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the process contracts**

```bash
git add src/vlc/command-spec.ts src/vlc/process-events.ts src/vlc/process-supervisor.ts test/unit/vlc/command-spec.test.ts test/unit/vlc/process-supervisor.test.ts
git commit -m "feat: define vlc command and supervision contracts"
```

### Task 3: Build the fake VLC executable and integration harness

**Files:**
- Create: `test/fixtures/fake-vlc.ts`
- Create: `test/helpers/temp-dir.ts`
- Create: `vitest.config.ts`
- Test: `test/integration/vlc/fake-vlc.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
import { describe, expect, it } from 'vitest'
import { runManagedProcess } from '../../../src/vlc/process-supervisor'
import { createCommandSpec } from '../../../src/vlc/command-spec'

describe('fake VLC integration', () => {
  it('writes a deterministic manifest and segment for HLS mode', async () => {
    const spec = createCommandSpec({
      executable: process.execPath,
      args: ['test/fixtures/fake-vlc.ts', '--mode=hls'],
      timeoutMs: 5000,
      label: 'fake-vlc-hls',
    })

    const result = await runManagedProcess(spec)
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('FAKE_VLC_DONE')
  })
})
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm test -- test/integration/vlc/fake-vlc.integration.test.ts`

Expected: FAIL because the fake VLC fixture and Vitest config do not exist yet.

- [ ] **Step 3: Configure Vitest with separate unit and integration projects**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          setupFiles: ['test/helpers/temp-dir.ts'],
        },
      },
    ],
  },
})
```

```typescript
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1]
const outDir = process.argv.find((arg) => arg.startsWith('--outDir='))?.split('=')[1] ?? '.cache/fake-vlc'

await mkdir(outDir, { recursive: true })

if (mode === 'hls') {
  await writeFile(join(outDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000.ts\n')
  await writeFile(join(outDir, 'segment-000.ts'), 'FAKE_TS_SEGMENT')
}

console.log('FAKE_VLC_DONE')
process.exit(0)
```

- [ ] **Step 4: Run the integration test again**

Run: `npm test -- test/integration/vlc/fake-vlc.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the fake VLC harness**

```bash
git add vitest.config.ts test/fixtures/fake-vlc.ts test/helpers/temp-dir.ts test/integration/vlc/fake-vlc.integration.test.ts
git commit -m "feat: add fake vlc integration harness"
```

### Task 4: Add real app configuration and health diagnostics around VLC preflight

**Files:**
- Create: `src/config.ts`
- Create: `src/vlc/find-vlc.ts`
- Modify: `src/app.ts`
- Test: `test/unit/config.test.ts`
- Test: `test/integration/health.integration.test.ts`

- [ ] **Step 1: Write the failing config and health tests**

```typescript
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config'

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({})
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
    expect(config.vlcCandidates.length).toBeGreaterThan(0)
  })
})
```

```typescript
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'

describe('health route', () => {
  it('reports VLC dependency status', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: ['missing-vlc.exe'],
      },
      services: {},
    })

    const response = await app.inject({ method: 'GET', url: '/api/health' })
    const body = response.json()

    expect(body).toHaveProperty('dependencies.vlc.found')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/config.test.ts test/integration/health.integration.test.ts`

Expected: FAIL because config loading and VLC discovery are incomplete.

- [ ] **Step 3: Implement config loading and health reporting**

```typescript
export interface AppConfig {
  host: string
  port: number
  cacheDir: string
  vlcCandidates: string[]
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    cacheDir: env.CACHE_DIR ?? '.cache',
    vlcCandidates: [
      env.VLC_PATH,
      'C:/Program Files/VideoLAN/VLC/vlc.exe',
      'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe',
    ].filter(Boolean) as string[],
  }
}
```

```typescript
import { access } from 'node:fs/promises'

export async function findVlc(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { found: true, path: candidate }
    } catch {
      // continue
    }
  }

  return { found: false, path: null }
}
```

```typescript
const vlc = await findVlc(deps.config.vlcCandidates)

app.get('/api/health', async () => ({
  ok: vlc.found,
  dependencies: {
    vlc,
  },
}))
```

- [ ] **Step 4: Re-run the config and health tests**

Run: `npm test -- test/unit/config.test.ts test/integration/health.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the config and health slice**

```bash
git add src/config.ts src/vlc/find-vlc.ts src/app.ts test/unit/config.test.ts test/integration/health.integration.test.ts
git commit -m "feat: add config loading and vlc health diagnostics"
```

### Task 5: Add Playwright smoke coverage for the harness-first slice

**Files:**
- Create: `playwright.config.ts`
- Create: `playwright/smoke.spec.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the first Playwright smoke test**

```typescript
import { test, expect } from '@playwright/test'

test('health endpoint is reachable from the running app', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/VLC DVD Streamer/i)
})
```

- [ ] **Step 2: Run Playwright to verify it fails**

Run: `npm run test:e2e -- --project=chromium`

Expected: FAIL because the config, homepage, and test server wiring do not exist yet.

- [ ] **Step 3: Add Playwright config with webServer and baseURL**

```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'playwright',
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
  },
})
```

- [ ] **Step 4: Add a minimal homepage and re-run Playwright**

Add this to `src/app.ts`:

```typescript
app.get('/', async (_request, reply) => {
  reply.type('text/html').send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>VLC DVD Streamer</title>
      </head>
      <body>
        <main>
          <h1>VLC DVD Streamer</h1>
          <p>Command harness and test foundation in progress.</p>
        </main>
      </body>
    </html>
  `)
})
```

Run: `npm run test:e2e -- --project=chromium`

Expected: PASS.

- [ ] **Step 5: Commit the browser smoke slice**

```bash
git add playwright.config.ts playwright/smoke.spec.ts package.json src/app.ts
git commit -m "test: add playwright smoke coverage for harness slice"
```

### Task 6: Verify the slice and prepare the next OpenSpec implementation step

**Files:**
- Modify: `README.md`
- Modify: `openspec/changes/implement-v1-dvd-streaming/tasks.md`

- [ ] **Step 1: Run the full non-hardware verification set**

Run:

```bash
npm run typecheck
npm test
npm run test:e2e -- --project=chromium
```

Expected: all commands exit successfully.

- [ ] **Step 2: Re-read the OpenSpec tasks and mark only completed items**

Mark these items complete if and only if the code exists and the commands above pass:

- `1.1` through `1.4`
- `2.1` through `2.4`
- `3.1` partially only if VLC preflight and supervision are implemented, otherwise leave unchecked
- `10.1` and `10.2` only if the full verification commands succeeded

- [ ] **Step 3: Update README with real local setup and verification commands**

Add:

```markdown
## Local Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run typecheck
npm test
npm run test:e2e -- --project=chromium
```
```

- [ ] **Step 4: Commit the verification and documentation update**

```bash
git add README.md openspec/changes/implement-v1-dvd-streaming/tasks.md
git commit -m "docs: record harness slice setup and verification"
```

## Spec Coverage Check

- Covers repository foundation, app factory, config, and health from the OpenSpec tasks.
- Covers the test-harness-first requirement with a fake VLC executable, Vitest projects, and Playwright smoke coverage.
- Covers the command-handling architecture decisions: shell-free execution, timeout-ready supervision, and structured process ownership.
- Intentionally does not yet implement real disc scanning, thumbnails, HLS readiness parsing, session replacement, or browser player UX beyond the smoke shell. Those belong to the next slice after this harness foundation is verified.