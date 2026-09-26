import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/vlc/real-vlc.integration.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 30000,
  },
})
