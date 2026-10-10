/**
 * @h5/game-client —— 房间 WebSocket 客户端
 *
 * - 建立 / 维护与房间 Durable Object 的 WebSocket 连接
 * - 断线自动重连，并携带服务端签发的身份令牌恢复座位
 * - 仅消费服务端权威 `ROOM_STATE`，不在本地模拟状态
 */

export { RoomClient, createLocalStorageIdentityStore } from './room-client';
export type {
  IdentityStorage,
  RoomClientErrorCode,
  RoomClientOptions,
  RoomClientSnapshot,
  RoomClientStatus,
  RoomIdentity,
} from './types';
