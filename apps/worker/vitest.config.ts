import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Durable Object 集成测试配置。
 *
 * 使用 Cloudflare 官方 `@cloudflare/vitest-plugin`，在真实 workerd 运行时中
 * 通过 `SELF.fetch` 与 WebSocket 访问 Worker 与 Durable Object。
 *
 * D1 迁移在测试启动前由 `test/setup.ts` 应用，保证 D1 写入路径被真实验证。
 */
const migrations = await readD1Migrations('../../database/migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
