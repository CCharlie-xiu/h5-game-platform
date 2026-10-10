import { PROTOCOL_VERSION } from '@h5/game-protocol';

/** 前端运行时环境信息，用于页面展示与问题排查。 */
export interface RuntimeInfo {
  /** 构建模式：development / production */
  readonly mode: string;
  readonly dev: boolean;
  readonly prod: boolean;
  /** 部署基础路径 */
  readonly baseUrl: string;
  readonly userAgent: string;
  /** 构建期注入的 Vite 版本 */
  readonly viteVersion: string;
  /** 构建期注入的构建时间 */
  readonly buildTime: string;
  /** 当前协议版本 */
  readonly protocolVersion: number;
}

/** 采集当前运行环境信息。 */
export function getRuntimeInfo(): RuntimeInfo {
  return {
    mode: import.meta.env.MODE,
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
    baseUrl: import.meta.env.BASE_URL,
    userAgent: typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent,
    viteVersion: __VITE_VERSION__,
    buildTime: __BUILD_TIME__,
    protocolVersion: PROTOCOL_VERSION,
  };
}
