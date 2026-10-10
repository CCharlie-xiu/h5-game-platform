import { defineConfig, devices } from '@playwright/test';

/**
 * 浏览器端端到端测试配置。
 *
 * 同时拉起本地 Worker（8787）与 Vite 开发服务器（5173），
 * 使用两个独立浏览器上下文验证联机房间流程。
 *
 * 注意：这里直接调用包内的二进制并使用 `cwd`，而不是 `pnpm --filter ... -- ...`，
 * 因为 pnpm 会把 `--` 原样透传给子命令，导致参数被忽略。
 * 人工开发仍使用 README 中的 `pnpm dev:worker` / `pnpm dev:web`。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node_modules/.bin/wrangler dev --port 8787',
      cwd: 'apps/worker',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort',
      cwd: 'apps/web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
