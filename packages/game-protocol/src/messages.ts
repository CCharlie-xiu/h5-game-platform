import { z } from 'zod';

import { ErrorCode, protocolError } from './errors';
import type { ProtocolError } from './errors';
import { leaveReasonSchema } from './phase';
import { playerSnapshotSchema, roomSnapshotSchema } from './snapshots';
import { PROTOCOL_VERSION } from './version';
import type { ProtocolVersion } from './version';

/* -------------------------------------------------------------------------- */
/* 消息类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 客户端 → 服务端：请求类消息。 */
export const ClientMessageType = {
  CreateRoom: 'CREATE_ROOM',
  JoinRoom: 'JOIN_ROOM',
  LeaveRoom: 'LEAVE_ROOM',
  PlayerReady: 'PLAYER_READY',
  PlayerUnready: 'PLAYER_UNREADY',
  GameStart: 'GAME_START',
  GamePause: 'GAME_PAUSE',
  GameResume: 'GAME_RESUME',
  GameEnd: 'GAME_END',
} as const;

/** 客户端消息类型。 */
export type ClientMessageType = (typeof ClientMessageType)[keyof typeof ClientMessageType];

/** 服务端 → 客户端：广播 / 响应类消息。 */
export const ServerMessageType = {
  RoomState: 'ROOM_STATE',
  PlayerJoined: 'PLAYER_JOINED',
  PlayerLeft: 'PLAYER_LEFT',
  PlayerReconnected: 'PLAYER_RECONNECTED',
  /** 创建房间成功后下发的服务端签发身份（playerId + token） */
  SessionGranted: 'SESSION_GRANTED',
  SystemError: 'SYSTEM_ERROR',
} as const;

/** 服务端消息类型。 */
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** 全部消息类型。 */
export type MessageType = ClientMessageType | ServerMessageType;

/** 全部消息类型常量。 */
export const MessageType = {
  ...ClientMessageType,
  ...ServerMessageType,
} as const;

/* -------------------------------------------------------------------------- */
/* 负载 Schema                                                                 */
/* -------------------------------------------------------------------------- */

/** 无负载消息（动作本身即语义）。 */
const emptyPayloadSchema = z.strictObject({});

/** CREATE_ROOM 负载。 */
export const createRoomPayloadSchema = z.strictObject({
  gameId: z.string().min(1).max(64),
  nickname: z.string().min(1).max(24),
  maxPlayers: z.number().int().min(2).max(8).optional(),
});

/** JOIN_ROOM 负载。携带 playerId + token 表示重连，否则视为新玩家。 */
export const joinRoomPayloadSchema = z.strictObject({
  roomCode: z.string().min(4).max(12),
  nickname: z.string().min(1).max(24),
  playerId: z.string().min(1).max(64).optional(),
  token: z.string().min(1).max(256).optional(),
});

/** 客户端请求负载 Schema 表。 */
export const clientPayloadSchemas = {
  CREATE_ROOM: createRoomPayloadSchema,
  JOIN_ROOM: joinRoomPayloadSchema,
  LEAVE_ROOM: emptyPayloadSchema,
  PLAYER_READY: emptyPayloadSchema,
  PLAYER_UNREADY: emptyPayloadSchema,
  GAME_START: emptyPayloadSchema,
  GAME_PAUSE: emptyPayloadSchema,
  GAME_RESUME: emptyPayloadSchema,
  GAME_END: emptyPayloadSchema,
} as const;

/** ROOM_STATE 负载：服务端权威房间快照。 */
export const roomStatePayloadSchema = z.strictObject({
  room: roomSnapshotSchema,
});

/** PLAYER_JOINED 负载。 */
export const playerJoinedPayloadSchema = z.strictObject({
  player: playerSnapshotSchema,
});

/** PLAYER_LEFT 负载。 */
export const playerLeftPayloadSchema = z.strictObject({
  playerId: z.string().min(1).max(64),
  nickname: z.string().min(1).max(24),
  reason: leaveReasonSchema,
});

/** PLAYER_RECONNECTED 负载。 */
export const playerReconnectedPayloadSchema = z.strictObject({
  playerId: z.string().min(1).max(64),
  nickname: z.string().min(1).max(24),
});

/** SYSTEM_ERROR 负载。 */
export const systemErrorPayloadSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** SESSION_GRANTED 负载：服务端签发的身份凭证。 */
export const sessionGrantedPayloadSchema = z.strictObject({
  roomCode: z.string().min(1).max(16),
  /** 稳定玩家标识 */
  playerId: z.string().min(1).max(64),
  /** 重连令牌（HMAC，由房间级密钥签发） */
  token: z.string().min(1).max(256),
  room: roomSnapshotSchema,
});

/** 服务端广播负载 Schema 表。 */
export const serverPayloadSchemas = {
  ROOM_STATE: roomStatePayloadSchema,
  PLAYER_JOINED: playerJoinedPayloadSchema,
  PLAYER_LEFT: playerLeftPayloadSchema,
  PLAYER_RECONNECTED: playerReconnectedPayloadSchema,
  SESSION_GRANTED: sessionGrantedPayloadSchema,
  SYSTEM_ERROR: systemErrorPayloadSchema,
} as const;

/* -------------------------------------------------------------------------- */
/* 封套                                                                        */
/* -------------------------------------------------------------------------- */

/** 统一消息封套。 */
export interface MessageEnvelope<TType extends string, TPayload> {
  /** 协议版本 */
  readonly protocolVersion: ProtocolVersion;
  /** 消息唯一标识，用于去重与追踪 */
  readonly messageId: string;
  /** 消息类型 */
  readonly type: TType;
  /** 房间标识；创建房间前允许缺省 */
  readonly roomId?: string;
  /** 对局标识；仅对局开始后需要 */
  readonly sessionId?: string;
  /** 消息负载 */
  readonly payload: TPayload;
}

/** 客户端请求负载类型映射。 */
export type ClientPayloadMap = {
  [K in keyof typeof clientPayloadSchemas]: z.infer<(typeof clientPayloadSchemas)[K]>;
};

/** 服务端广播负载类型映射。 */
export type ServerPayloadMap = {
  [K in keyof typeof serverPayloadSchemas]: z.infer<(typeof serverPayloadSchemas)[K]>;
};

/** 客户端请求消息（判别联合）。 */
export type ClientMessage = {
  [K in ClientMessageType]: MessageEnvelope<K, ClientPayloadMap[K]>;
}[ClientMessageType];

/** 服务端广播消息（判别联合）。 */
export type ServerMessage = {
  [K in ServerMessageType]: MessageEnvelope<K, ServerPayloadMap[K]>;
}[ServerMessageType];

/* -------------------------------------------------------------------------- */
/* 校验                                                                        */
/* -------------------------------------------------------------------------- */

/** 解析结果。 */
export type ParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly error: ProtocolError };

const envelopeSchema = z.object({
  protocolVersion: z.number().int(),
  messageId: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  roomId: z.string().min(1).max(16).optional(),
  sessionId: z.string().min(1).max(64).optional(),
  payload: z.unknown(),
});

function summarizeIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/** 封套解析结果。 */
type EnvelopeParseResult =
  | {
      readonly ok: true;
      readonly type: string;
      readonly envelope: z.infer<typeof envelopeSchema>;
      readonly payload: unknown;
    }
  | { readonly ok: false; readonly error: ProtocolError };

function parseEnvelope(
  raw: string,
  allowedTypes: readonly string[],
  payloadSchemas: Record<string, z.ZodType>,
): EnvelopeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: protocolError(ErrorCode.InvalidMessage, '消息不是合法 JSON') };
  }

  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    return {
      ok: false,
      error: protocolError(ErrorCode.InvalidMessage, '消息封套结构不合法', {
        issues: summarizeIssues(envelope.error),
      }),
    };
  }

  const { protocolVersion, type, payload } = envelope.data;

  if (protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: protocolError(
        ErrorCode.ProtocolVersionMismatch,
        `协议版本不匹配：期望 ${PROTOCOL_VERSION}，收到 ${protocolVersion}`,
        { expected: PROTOCOL_VERSION, received: protocolVersion },
      ),
    };
  }

  if (!allowedTypes.includes(type)) {
    return {
      ok: false,
      error: protocolError(ErrorCode.UnknownMessageType, `未知消息类型：${type}`, { type }),
    };
  }

  const payloadSchema = payloadSchemas[type];
  if (!payloadSchema) {
    return {
      ok: false,
      error: protocolError(ErrorCode.UnknownMessageType, `消息类型缺少负载 Schema：${type}`, { type }),
    };
  }

  const parsedPayload = payloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return {
      ok: false,
      error: protocolError(ErrorCode.InvalidMessage, `消息负载不合法：${type}`, {
        type,
        issues: summarizeIssues(parsedPayload.error),
      }),
    };
  }

  return {
    ok: true,
    type,
    envelope: envelope.data,
    payload: parsedPayload.data,
  };
}

const clientTypes = Object.values(ClientMessageType) as readonly string[];
const serverTypes = Object.values(ServerMessageType) as readonly string[];

/** 解析并校验一条客户端请求消息。 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const result = parseEnvelope(raw, clientTypes, clientPayloadSchemas as Record<string, z.ZodType>);
  if (!result.ok) {
    return result;
  }
  const { envelope, payload } = result;
  const message = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: envelope.messageId,
    type: envelope.type,
    ...(envelope.roomId === undefined ? {} : { roomId: envelope.roomId }),
    ...(envelope.sessionId === undefined ? {} : { sessionId: envelope.sessionId }),
    payload,
  };
  return { ok: true, message: message as ClientMessage };
}

/** 解析并校验一条服务端广播消息。 */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const result = parseEnvelope(raw, serverTypes, serverPayloadSchemas as Record<string, z.ZodType>);
  if (!result.ok) {
    return result;
  }
  const { envelope, payload } = result;
  const message = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: envelope.messageId,
    type: envelope.type,
    ...(envelope.roomId === undefined ? {} : { roomId: envelope.roomId }),
    ...(envelope.sessionId === undefined ? {} : { sessionId: envelope.sessionId }),
    payload,
  };
  return { ok: true, message: message as ServerMessage };
}

/* -------------------------------------------------------------------------- */
/* 构造                                                                        */
/* -------------------------------------------------------------------------- */

let messageCounter = 0;

/** 生成消息标识（时间戳 + 进程内自增 + 随机后缀）。 */
export function createMessageId(): string {
  messageCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${messageCounter.toString(36)}-${random}`;
}

/** 构造客户端请求消息。 */
export function createClientMessage<K extends ClientMessageType>(
  type: K,
  payload: ClientPayloadMap[K],
  options: { roomId?: string; sessionId?: string; messageId?: string } = {},
): ClientMessage {
  const envelope: MessageEnvelope<K, ClientPayloadMap[K]> = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: options.messageId ?? createMessageId(),
    type,
    ...(options.roomId === undefined ? {} : { roomId: options.roomId }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    payload,
  };
  return envelope as ClientMessage;
}

/** 构造服务端广播消息。 */
export function createServerMessage<K extends ServerMessageType>(
  type: K,
  payload: ServerPayloadMap[K],
  options: { roomId?: string; sessionId?: string; messageId?: string } = {},
): ServerMessage {
  const envelope: MessageEnvelope<K, ServerPayloadMap[K]> = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: options.messageId ?? createMessageId(),
    type,
    ...(options.roomId === undefined ? {} : { roomId: options.roomId }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    payload,
  };
  return envelope as ServerMessage;
}

/** 序列化消息为 JSON 字符串。 */
export function serializeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
