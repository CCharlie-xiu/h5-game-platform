import type { ErrorCode, ProtocolError, RoomSnapshot } from '@h5/game-protocol';

/** 客户端连接状态。 */
export type RoomClientStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/** 服务端签发的身份凭证。 */
export interface RoomIdentity {
  readonly roomCode: string;
  readonly playerId: string;
  readonly token: string;
  /** 最近使用的昵称（仅客户端本地保存，便于重连时复用） */
  readonly nickname?: string;
}

/** 身份持久化接口（Web 端可用 localStorage 实现）。 */
export interface IdentityStorage {
  load(): RoomIdentity | null;
  save(identity: RoomIdentity): void;
  clear(): void;
}

/** 客户端对外快照（不可变，供 React `useSyncExternalStore` 使用）。 */
export interface RoomClientSnapshot {
  readonly status: RoomClientStatus;
  readonly identity: RoomIdentity | null;
  /** 服务端权威房间状态；未收到前为 null */
  readonly room: RoomSnapshot | null;
  readonly lastError: ProtocolError | null;
  readonly reconnectAttempts: number;
}

/** 构造选项。 */
export interface RoomClientOptions {
  /** HTTP 基地址（例如 `http://127.0.0.1:8787`）。留空则使用同源。 */
  readonly baseUrl?: string;
  /** 身份持久化；不传则仅保存在内存中 */
  readonly storage?: IdentityStorage;
  /** 最大自动重连次数 */
  readonly maxReconnectAttempts?: number;
  /** 重连退避基数（毫秒） */
  readonly reconnectBaseDelayMs?: number;
  /** WebSocket 工厂，便于测试注入 */
  readonly webSocketFactory?: (url: string) => WebSocket;
}

/** 错误码透传类型（协议层为 string，此处收敛为 ErrorCode）。 */
export type RoomClientErrorCode = ErrorCode;
