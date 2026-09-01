import { defineConfig, devices } from '@playwright/test'

const strictAppAuthE2E = process.env.PLAYWRIGHT_AUTH_E2E === '1'
const e2eStateDir = `.wrangler/e2e-state-${process.pid}-${Date.now()}`
const e2eConfig = strictAppAuthE2E ? 'wrangler.auth-e2e.toml' : 'wrangler.e2e.toml'
const e2eWorkerCommand = `npx -y -p wrangler@4.127.1 wrangler dev --config ${e2eConfig} --local --port 8799 --persist-to ${e2eStateDir}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // The suite intentionally shares one local Wrangler/D1 instance. Serial browser
  // workers prevent concurrent seed/mutation requests from crashing local workerd.
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Browser-level routing assertions must see network failures deterministically.
    // Blocking the PWA service worker in E2E prevents a cached preview from bypassing
    // page.route() and keeps each fresh Playwright process isolated from SW state.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `node tests/e2e/prepare-state.mjs ${e2eStateDir} && node tests/e2e/migrate-e2e.mjs ${e2eStateDir} && ${e2eWorkerCommand}`,
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    timeout: 120_000,
  },
})
