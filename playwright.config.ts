import { defineConfig } from '@playwright/test'

const port = 3100

export default defineConfig({
  testDir: './playwright',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  webServer: {
    command: 'npm run start:foreground',
    port,
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1',
      PORT: String(port),
      VLC_PATH: process.execPath,
      VLC_SHIM_SCRIPT: 'test/fixtures/fake-vlc.ts',
      DVD_DRIVE: 'D:',
    },
  },
})