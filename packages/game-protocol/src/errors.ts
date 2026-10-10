import { z } from 'zod';

/**
 * 协议级错误码。
 *
 * 所有错误响应统一使用 `SYSTEM_ERROR` 消息，`code` 取自本枚举。
 */
export const ErrorCode = {
  /** 消息不是合法 JSON，或封套结构不合法 */
  InvalidMessage: 'INVALID_MESSAGE',
  /** 消息类型不在已知集合内 */
  UnknownMessageType: 'UNKNOWN_MESSAGE_TYPE',
  /** 协议版本不匹配 */
  ProtocolVersionMismatch: 'PROTOCOL_VERSION_MISMATCH',
  /** 房间不存在或已过期 */
  RoomNotFound: 'ROOM_NOT_FOUND',
  /** 房间已满 */
  RoomFull: 'ROOM_FULL',
  /** 房间码冲突（内部重试用） */
  RoomExists: 'ROOM_EXISTS',
  /** 当前连接尚未加入房间 */
  NotInRoom: 'NOT_IN_ROOM',
  /** 玩家已在本房间（重复加入） */
  AlreadyInRoom: 'ALREADY_IN_ROOM',
  /** 需要房主权限 */
  NotHost: 'NOT_HOST',
  /** 玩家人数不足 */
  NotEnoughPlayers: 'NOT_ENOUGH_PLAYERS',
  /** 有玩家未准备 */
  PlayersNotReady: 'PLAYERS_NOT_READY',
  /** 当前生命周期阶段不允许该操作 */
  InvalidTransition: 'INVALID_TRANSITION',
  /** 身份校验失败（令牌缺失或无效） */
  Unauthorized: 'UNAUTHORIZED',
  /** 会话不匹配 */
  SessionMismatch: 'SESSION_MISMATCH',
  /** 重复消息（同一 messageId 已处理） */
  DuplicateMessage: 'DUPLICATE_MESSAGE',
  /** 服务端内部错误 */
  InternalError: 'INTERNAL_ERROR',
} as const;

/** 错误码类型。 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 Zod 枚举。 */
export const errorCodeSchema = z.enum([
  ErrorCode.InvalidMessage,
  ErrorCode.UnknownMessageType,
  ErrorCode.ProtocolVersionMismatch,
  ErrorCode.RoomNotFound,
  ErrorCode.RoomFull,
  ErrorCode.RoomExists,
  ErrorCode.NotInRoom,
  ErrorCode.AlreadyInRoom,
  ErrorCode.NotHost,
  ErrorCode.NotEnoughPlayers,
  ErrorCode.PlayersNotReady,
  ErrorCode.InvalidTransition,
  ErrorCode.Unauthorized,
  ErrorCode.SessionMismatch,
  ErrorCode.DuplicateMessage,
  ErrorCode.InternalError,
]);

/** 结构化错误描述，用于 SYSTEM_ERROR 负载。 */
export interface ProtocolError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** 构造协议错误。 */
export function protocolError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ProtocolError {
  return details ? { code, message, details } : { code, message };
}
