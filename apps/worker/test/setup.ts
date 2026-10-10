import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * 集成测试前置：把 `database/migrations` 下的迁移应用到隔离的测试 D1。
 *
 * 迁移内容由 `vitest.config.ts` 通过 `readD1Migrations` 读取，
 * 并以 `TEST_MIGRATIONS` 绑定注入测试环境。
 */
const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
