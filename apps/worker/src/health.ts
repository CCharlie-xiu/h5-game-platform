import { PROTOCOL_VERSION } from '@h5/game-protocol';

/** Worker 服务名。 */
export const SERVICE_NAME = 'h5-game-platform-worker';

/** `GET /api/health` 的响应体。 */
export interface HealthPayload {
  readonly status: 'ok';
  readonly service: string;
  readonly environment: string;
  readonly protocolVersion: number;
  readonly timestamp: string;
}

/** 构造健康检查响应体（纯函数，便于测试）。 */
export function buildHealthPayload(environment: string, now: Date = new Date()): HealthPayload {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    environment,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: now.toISOString(),
  };
}
