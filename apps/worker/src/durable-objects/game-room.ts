import {
  ClientMessageType,
  ErrorCode,
  createServerMessage,
  parseClientMessage,
  protocolError,
  serializeMessage,
} from '@h5/game-protocol';
import type {
  ClientMessage,
  LeaveReason,
  ProtocolError,
  RoomSnapshot,
  ServerMessage,
} from '@h5/game-protocol';
import {
  LifecycleTrigger,
  ROOM_LIMITS,
  applyTrigger,
  attachConnection,
  createRoom,
  detachConnection,
  findPlayer,
  generateId,
  generateSecret,
  isValidRoomCode,
  join,
  leave,
  setReady,
  signToken,
  toPlayerSnapshot,
  toSnapshot,
  verifyToken,
} from '@h5/game-core';
import type { RoomRecord } from '@h5/game-core';

import { createRoomRepository } from '../db/repository';
import type { RoomRepository } from '../db/repository';
import type { Env } from '../env';

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 房间状态在 Durable Object storage 中的键。 */
const ROOM_STORAGE_KEY = 'room';

/** 清理检查间隔。 */
const CLEANUP_INTERVAL_MS = 60_000;

/** 无在线玩家后，多久销毁房间。 */
const EMPTY_ROOM_TTL_MS = 60_000;

/** 完全无活动后，多久销毁房间。 */
const IDLE_ROOM_TTL_MS = 30 * 60_000;

/** 去重窗口大小。 */
const MAX_SEEN_MESSAGES = 200;

type CreateRoomMessage = Extract<ClientMessage, { type: 'CREATE_ROOM' }>;
type JoinRoomMessage = Extract<ClientMessage, { type: 'JOIN_ROOM' }>;

/** WebSocket 附件：与 socket 绑定的连接级信息（跨休眠保留）。 */
interface SocketAttachment {
  readonly connectionId: string;
  readonly playerId: string | null;
  readonly connectedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Durable Object                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 房间 Durable Object。
 *
 * 设计要点：
 * - 每个房间码对应一个确定的 DO 实例（`idFromName(roomCode)`）
 * - 房间状态持久化在 `state.storage`，内存缓存仅作为加速，**不是**唯一来源
 * - WebSocket 使用 Hibernation API（`acceptWebSocket` + `serializeAttachment`），
 *   实例休眠后连接与身份仍然保留
 * - 所有客户端输入都经过协议 Schema 校验 + 权限校验 + 状态转换校验
 * - D1 只写离散生命周期事件，不参与实时同步
 */
export class GameRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly repository: RoomRepository;

  /** 内存缓存（加速用；权威状态在 storage）。 */
  private cached: RoomRecord | null = null;

  /** 单实例内的消息去重窗口。 */
  private readonly seen = new Set<string>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.repository = createRoomRepository(env.DB);
    void this.state.blockConcurrencyWhile(async () => {
      this.cached = await this.readRoom();
    });
  }

  /* ------------------------------- HTTP 入口 ------------------------------ */

  async fetch(request: Request): Promise<Response> {
    // WebSocket 升级请求直接透传处理（Worker 以 `stub.fetch(request)` 原样转发）
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleUpgrade(request);
    }

    const { pathname } = new URL(request.url);

    if (pathname.endsWith('/create')) {
      return this.handleHttpCreate(request);
    }
    if (pathname.endsWith('/snapshot')) {
      return this.handleHttpSnapshot();
    }
    return Response.json({ error: 'not_found', path: pathname }, { status: 404 });
  }

  /** 创建房间（由 Worker 在选定房间码后调用，保证唯一性）。 */
  private async handleHttpCreate(request: Request): Promise<Response> {
    const roomCode = this.roomCode();
    if (!isValidRoomCode(roomCode)) {
      return Response.json({ error: ErrorCode.InvalidMessage, message: '房间码不合法' }, { status: 400 });
    }
    if (await this.requireRoom()) {
      return Response.json({ error: ErrorCode.RoomExists }, { status: 409 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: ErrorCode.InvalidMessage, message: '请求体不是合法 JSON' }, { status: 400 });
    }

    const input = (body ?? {}) as Record<string, unknown>;
    const gameId = typeof input.gameId === 'string' ? input.gameId : '';
    const nickname = typeof input.nickname === 'string' ? input.nickname : '';
    if (!gameId || !nickname) {
      return Response.json(
        { error: ErrorCode.InvalidMessage, message: 'gameId 与 nickname 必填' },
        { status: 400 },
      );
    }
    const maxPlayers = typeof input.maxPlayers === 'number' ? input.maxPlayers : undefined;

    const now = Date.now();
    const hostPlayerId = generateId('p_');
    const authSecret = generateSecret();
    const room = createRoom({
      roomId: roomCode,
      roomCode,
      gameId,
      hostPlayerId,
      hostNickname: nickname.slice(0, ROOM_LIMITS.nicknameMaxLength),
      authSecret,
      maxPlayers,
      now,
    });

    await this.persist(room);
    await this.scheduleCleanup();

    const snapshot = toSnapshot(room);
    this.state.waitUntil(this.safe(() => this.recordRoomCreated(room, snapshot)));

    const token = await signToken(authSecret, roomCode, hostPlayerId);
    return Response.json({ roomCode, playerId: hostPlayerId, token, room: snapshot });
  }

  /** 只读快照（用于调试与集成测试）。 */
  private async handleHttpSnapshot(): Promise<Response> {
    const room = await this.requireRoom();
    if (!room) {
      return Response.json({ error: ErrorCode.RoomNotFound }, { status: 404 });
    }
    return Response.json({ room: toSnapshot(room) });
  }

  /** WebSocket 升级。 */
  private handleUpgrade(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const attachment: SocketAttachment = {
      connectionId: generateId('c_', 8),
      playerId: null,
      connectedAt: Date.now(),
    };

    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ----------------------------- WebSocket 回调 --------------------------- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.sendError(ws, protocolError(ErrorCode.InvalidMessage, '仅支持文本帧'));
      return;
    }

    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      this.sendError(ws, parsed.error);
      return;
    }

    if (!this.remember(parsed.message.messageId)) {
      this.sendError(
        ws,
        protocolError(ErrorCode.DuplicateMessage, '重复消息已忽略', {
          messageId: parsed.message.messageId,
        }),
      );
      return;
    }

    try {
      await this.dispatch(ws, parsed.message);
    } catch (error) {
      console.error('[GameRoom] 处理消息失败', error);
      this.sendError(ws, protocolError(ErrorCode.InternalError, '服务端处理失败'));
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, wasClean: boolean): Promise<void> {
    await this.handleDisconnect(ws, wasClean ? 'LEFT' : 'DISCONNECTED');
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[GameRoom] WebSocket 错误', error);
    await this.handleDisconnect(ws, 'DISCONNECTED');
  }

  /** 房间清理：无在线玩家或长时间无活动时销毁。 */
  async alarm(): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      await this.state.storage.deleteAll();
      this.cached = null;
      return;
    }

    const now = Date.now();
    const online = room.players.filter((player) => player.online).length;
    const idleFor = now - room.lastActivityAt;

    const shouldDestroy =
      (online === 0 && idleFor >= EMPTY_ROOM_TTL_MS) || idleFor >= IDLE_ROOM_TTL_MS;

    if (shouldDestroy) {
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.close(1000, 'room closed');
        } catch {
          // 忽略已关闭的连接
        }
      }
      await this.state.storage.deleteAll();
      this.cached = null;
      return;
    }

    await this.scheduleCleanup();
  }

  /* -------------------------------- 分发 --------------------------------- */

  private async dispatch(ws: WebSocket, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case ClientMessageType.CreateRoom:
        await this.onCreateRoom(ws, message);
        return;
      case ClientMessageType.JoinRoom:
        await this.onJoinRoom(ws, message);
        return;
      case ClientMessageType.LeaveRoom:
        await this.onLeaveRoom(ws);
        return;
      case ClientMessageType.PlayerReady:
        await this.onSetReady(ws, true);
        return;
      case ClientMessageType.PlayerUnready:
        await this.onSetReady(ws, false);
        return;
      case ClientMessageType.GameStart:
        await this.onTrigger(ws, LifecycleTrigger.Start);
        return;
      case ClientMessageType.GamePause:
        await this.onTrigger(ws, LifecycleTrigger.Pause);
        return;
      case ClientMessageType.GameResume:
        await this.onTrigger(ws, LifecycleTrigger.Resume);
        return;
      case ClientMessageType.GameEnd:
        await this.onTrigger(ws, LifecycleTrigger.End);
        return;
      default:
        this.sendError(ws, protocolError(ErrorCode.UnknownMessageType, '未知消息类型'));
    }
  }

  /* ------------------------------ 消息处理 -------------------------------- */

  private async onCreateRoom(ws: WebSocket, message: CreateRoomMessage): Promise<void> {
    const attachment = this.attachmentOf(ws);
    if (attachment.playerId) {
      this.sendError(ws, protocolError(ErrorCode.AlreadyInRoom, '当前连接已加入房间'));
      return;
    }

    const roomCode = this.roomCode();
    if (!isValidRoomCode(roomCode)) {
      this.sendError(ws, protocolError(ErrorCode.InvalidMessage, '房间码不合法'));
      return;
    }
    if (await this.requireRoom()) {
      this.sendError(ws, protocolError(ErrorCode.RoomExists, '房间已存在'));
      return;
    }

    const now = Date.now();
    const { gameId, nickname, maxPlayers } = message.payload;
    const hostPlayerId = generateId('p_');
    const authSecret = generateSecret();

    const room = createRoom({
      roomId: roomCode,
      roomCode,
      gameId,
      hostPlayerId,
      hostNickname: nickname.slice(0, ROOM_LIMITS.nicknameMaxLength),
      authSecret,
      maxPlayers,
      now,
    });

    await this.persist(room);
    await this.scheduleCleanup();

    ws.serializeAttachment({ ...attachment, playerId: hostPlayerId });

    const token = await signToken(authSecret, roomCode, hostPlayerId);
    this.send(
      ws,
      createServerMessage(
        'SESSION_GRANTED',
        { roomCode, playerId: hostPlayerId, token, room: toSnapshot(room) },
        { roomId: roomCode },
      ),
    );

    const snapshot = toSnapshot(room);
    this.state.waitUntil(this.safe(() => this.recordRoomCreated(room, snapshot)));
  }

  private async onJoinRoom(ws: WebSocket, message: JoinRoomMessage): Promise<void> {
    const attachment = this.attachmentOf(ws);
    if (attachment.playerId) {
      this.sendError(ws, protocolError(ErrorCode.AlreadyInRoom, '当前连接已加入房间'));
      return;
    }

    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const { nickname, playerId: claimedPlayerId, token } = message.payload;
    const roomCode = room.roomCode;
    const now = Date.now();

    // 1) 携带令牌 → 重连
    if (claimedPlayerId && token) {
      const valid = await verifyToken(room.authSecret, roomCode, claimedPlayerId, token);
      if (!valid) {
        this.sendError(ws, protocolError(ErrorCode.Unauthorized, '身份令牌无效'));
        return;
      }
      const existing = findPlayer(room, claimedPlayerId);
      if (!existing) {
        this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '玩家不存在，无法恢复'));
        return;
      }

      this.closeOtherSockets(claimedPlayerId, attachment.connectionId);

      const attached = attachConnection(room, claimedPlayerId, attachment.connectionId, now);
      if (!attached.ok) {
        this.sendError(ws, attached.error);
        return;
      }

      await this.persist(attached.room);
      await this.scheduleCleanup();
      ws.serializeAttachment({ ...attachment, playerId: claimedPlayerId });

      this.send(
        ws,
        createServerMessage(
          'SESSION_GRANTED',
          {
            roomCode,
            playerId: claimedPlayerId,
            token,
            room: toSnapshot(attached.room),
          },
          { roomId: roomCode, sessionId: attached.room.sessionId ?? undefined },
        ),
      );
      this.broadcast(
        createServerMessage(
          'PLAYER_RECONNECTED',
          { playerId: claimedPlayerId, nickname: existing.nickname },
          { roomId: roomCode },
        ),
        attachment.connectionId,
      );
      this.broadcastState(attached.room);
      return;
    }

    // 2) 新玩家
    const newPlayerId = generateId('p_');
    const result = join(room, {
      playerId: newPlayerId,
      nickname: nickname.slice(0, ROOM_LIMITS.nicknameMaxLength),
      connectionId: attachment.connectionId,
      now,
    });
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
    await this.scheduleCleanup();
    ws.serializeAttachment({ ...attachment, playerId: newPlayerId });

    const newToken = await signToken(result.room.authSecret, roomCode, newPlayerId);
    this.send(
      ws,
      createServerMessage(
        'SESSION_GRANTED',
        { roomCode, playerId: newPlayerId, token: newToken, room: toSnapshot(result.room) },
        { roomId: roomCode, sessionId: result.room.sessionId ?? undefined },
      ),
    );

    const playerSnapshot = toPlayerSnapshot(result.room, newPlayerId);
    if (playerSnapshot) {
      this.broadcast(
        createServerMessage('PLAYER_JOINED', { player: playerSnapshot }, { roomId: roomCode }),
        attachment.connectionId,
      );
      this.state.waitUntil(
        this.safe(() => this.repository.recordPlayerJoined(roomCode, playerSnapshot)),
      );
    }
    this.broadcastState(result.room);
    this.state.waitUntil(
      this.safe(() => this.repository.recordRoomStatus(toSnapshot(result.room))),
    );
  }

  private async onLeaveRoom(ws: WebSocket): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const attachment = this.attachmentOf(ws);
    if (!attachment.playerId) {
      this.sendError(ws, protocolError(ErrorCode.NotInRoom, '当前连接尚未加入房间'));
      return;
    }

    const player = findPlayer(room, attachment.playerId);
    const result = leave(room, attachment.playerId, Date.now());
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
    await this.scheduleCleanup();
    ws.serializeAttachment({ ...attachment, playerId: null });

    if (player) {
      this.broadcast(
        createServerMessage(
          'PLAYER_LEFT',
          { playerId: player.playerId, nickname: player.nickname, reason: 'LEFT' },
          { roomId: room.roomCode },
        ),
        attachment.connectionId,
      );
      this.state.waitUntil(
        this.safe(() => this.repository.recordPlayerLeft(room.roomCode, player.playerId, Date.now())),
      );
    }
    this.broadcastState(result.room);
    this.state.waitUntil(
      this.safe(() => this.repository.recordRoomStatus(toSnapshot(result.room))),
    );
  }

  private async onSetReady(ws: WebSocket, ready: boolean): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const attachment = this.attachmentOf(ws);
    if (!attachment.playerId) {
      this.sendError(ws, protocolError(ErrorCode.NotInRoom, '当前连接尚未加入房间'));
      return;
    }

    const result = setReady(room, attachment.playerId, ready, Date.now());
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
    await this.scheduleCleanup();
    this.broadcastState(result.room);
  }

  private async onTrigger(ws: WebSocket, trigger: LifecycleTrigger): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const attachment = this.attachmentOf(ws);
    if (!attachment.playerId) {
      this.sendError(ws, protocolError(ErrorCode.NotInRoom, '当前连接尚未加入房间'));
      return;
    }

    const previousSessionId = room.sessionId;
    const result = applyTrigger(room, trigger, attachment.playerId, Date.now());
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
    await this.scheduleCleanup();
    this.broadcastState(result.room);

    const now = Date.now();
    const nextSessionId = result.room.sessionId;

    if (trigger === LifecycleTrigger.Start && nextSessionId) {
      this.state.waitUntil(
        this.safe(() =>
          this.repository.recordSessionStarted(room.roomCode, room.gameId, nextSessionId, now),
        ),
      );
    }
    if (trigger === LifecycleTrigger.End && previousSessionId) {
      this.state.waitUntil(
        this.safe(() => this.repository.recordSessionEnded(previousSessionId, now)),
      );
    }
    this.state.waitUntil(
      this.safe(() => this.repository.recordRoomStatus(toSnapshot(result.room))),
    );
  }

  private async handleDisconnect(ws: WebSocket, reason: LeaveReason): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      return;
    }

    const attachment = this.attachmentOf(ws);
    if (!attachment.playerId) {
      return;
    }

    const player = findPlayer(room, attachment.playerId);
    if (!player) {
      return;
    }

    const result = detachConnection(room, attachment.playerId, attachment.connectionId, Date.now());
    if (!result.ok) {
      return;
    }
    if (result.room === room) {
      // 连接已被新连接替换，无需处理
      return;
    }

    await this.persist(result.room);
    await this.scheduleCleanup();

    this.broadcast(
      createServerMessage(
        'PLAYER_LEFT',
        { playerId: player.playerId, nickname: player.nickname, reason },
        { roomId: room.roomCode },
      ),
    );
    this.broadcastState(result.room);
  }

  /* -------------------------------- 工具 --------------------------------- */

  private roomCode(): string {
    return this.state.id.name ?? '';
  }

  private async readRoom(): Promise<RoomRecord | null> {
    const stored = await this.state.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    return stored ?? null;
  }

  private async requireRoom(): Promise<RoomRecord | null> {
    if (!this.cached) {
      this.cached = await this.readRoom();
    }
    return this.cached;
  }

  private async persist(room: RoomRecord): Promise<void> {
    this.cached = room;
    await this.state.storage.put(ROOM_STORAGE_KEY, room);
  }

  private async scheduleCleanup(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }

  private async safe(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.error('[GameRoom] D1 写入失败（不影响房间状态）', error);
    }
  }

  /** 写入房间元数据 + 房主参与记录。 */
  private async recordRoomCreated(room: RoomRecord, snapshot: RoomSnapshot): Promise<void> {
    await this.repository.recordRoomCreated(snapshot);
    const host = toPlayerSnapshot(room, room.hostPlayerId);
    if (host) {
      await this.repository.recordPlayerJoined(room.roomCode, host);
    }
  }

  private attachmentOf(ws: WebSocket): SocketAttachment {
    const raw = ws.deserializeAttachment() as SocketAttachment | null;
    if (raw && typeof raw.connectionId === 'string') {
      return raw;
    }
    return { connectionId: 'unknown', playerId: null, connectedAt: 0 };
  }

  private remember(messageId: string): boolean {
    if (this.seen.has(messageId)) {
      return false;
    }
    this.seen.add(messageId);
    if (this.seen.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  /** 关闭某玩家除当前连接以外的所有连接（重复连接处理）。 */
  private closeOtherSockets(playerId: string, exceptConnectionId: string): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment.playerId === playerId && attachment.connectionId !== exceptConnectionId) {
        try {
          socket.close(4001, 'replaced by new connection');
        } catch {
          // 忽略已关闭的连接
        }
      }
    }
  }

  /** 广播给房间内所有已加入的连接；可排除指定连接。 */
  private broadcast(message: ServerMessage, exceptConnectionId?: string): void {
    const payload = serializeMessage(message);
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      // 未加入房间的连接不接收房间广播
      if (!attachment.playerId) {
        continue;
      }
      if (exceptConnectionId && attachment.connectionId === exceptConnectionId) {
        continue;
      }
      this.sendRaw(socket, payload);
    }
  }

  private broadcastState(room: RoomRecord): void {
    this.broadcast(
      createServerMessage(
        'ROOM_STATE',
        { room: toSnapshot(room) },
        { roomId: room.roomCode, sessionId: room.sessionId ?? undefined },
      ),
    );
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    this.sendRaw(ws, serializeMessage(message));
  }

  private sendRaw(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      // 连接可能已关闭，忽略
    }
  }

  private sendError(ws: WebSocket, error: ProtocolError): void {
    this.send(
      ws,
      createServerMessage('SYSTEM_ERROR', {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      }),
    );
  }
}
