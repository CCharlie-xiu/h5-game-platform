import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit 配置。
 *
 * - `schema` 指向 Worker 内的表定义
 * - `out` 指向仓库根目录的 `database/migrations`，与 wrangler.toml 的
 *   `migrations_dir` 保持一致，生成的 SQL 由 `wrangler d1 migrations apply` 执行
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: '../../database/migrations',
});
