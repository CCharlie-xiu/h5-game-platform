/** Worker `GET /api/health` 的响应体。 */
export interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly environment: string;
  readonly protocolVersion: number;
  readonly timestamp: string;
}

/** 健康检查结果，成功与失败都作为数据返回，便于 UI 直接渲染。 */
export type HealthResult =
  | { readonly ok: true; readonly data: HealthResponse }
  | { readonly ok: false; readonly error: string };

/**
 * 请求 Worker 健康检查接口。
 *
 * 开发期由 Vite 代理 `/api` 到本地 Worker；Worker 未启动时会返回失败结果，
 * 不会抛出异常。
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResult> {
  try {
    const response = await fetch('/api/health', { signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as HealthResponse;
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
