import { z } from 'zod';

import { gamePhaseSchema } from './phase';

/** 玩家快照（服务端权威）。 */
export const playerSnapshotSchema = z.strictObject({
  /** 稳定玩家标识，由服务端签发 */
  playerId: z.string().min(1).max(64),
  /** 昵称 */
  nickname: z.string().min(1).max(24),
  /** 是否为房主 */
  isHost: z.boolean(),
  /** 是否已准备 */
  ready: z.boolean(),
  /** 是否在线（WebSocket 已连接） */
  online: z.boolean(),
  /** 座位号，从 0 开始，按加入顺序分配 */
  seat: z.number().int().min(0),
  /** 加入时间戳（毫秒） */
  joinedAt: z.number().int().nonnegative(),
});

/** 玩家快照类型。 */
export type PlayerSnapshot = z.infer<typeof playerSnapshotSchema>;

/** 房间快照（服务端权威，客户端唯一可信状态来源）。 */
export const roomSnapshotSchema = z.strictObject({
  /** 房间标识（与房间码一致） */
  roomId: z.string().min(1).max(16),
  /** 房间码，供玩家输入加入 */
  roomCode: z.string().min(1).max(16),
  /** 游戏标识 */
  gameId: z.string().min(1).max(64),
  /** 生命周期阶段 */
  phase: gamePhaseSchema,
  /** 房主玩家标识 */
  hostPlayerId: z.string().min(1).max(64),
  /** 最少开局人数 */
  minPlayers: z.number().int().min(2).max(8),
  /** 最大人数 */
  maxPlayers: z.number().int().min(2).max(8),
  /** 当前对局标识；未开局为 null */
  sessionId: z.string().nullable(),
  /** 状态版本号，每次变更 +1 */
  revision: z.number().int().nonnegative(),
  /** 创建时间戳（毫秒） */
  createdAt: z.number().int().nonnegative(),
  /** 最近更新时间戳（毫秒） */
  updatedAt: z.number().int().nonnegative(),
  /** 玩家列表（含离线待重连玩家） */
  players: z.array(playerSnapshotSchema),
});

/** 房间快照类型。 */
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
