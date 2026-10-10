import {
  ClientMessageType,
  ErrorCode,
  createServerMessage,
  parseClientMessage,
  protocolError,
  roomSnapshotSchema,
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
  applyTrigger,
  attachConnection,
  checkEnvelopeScope,
  createRoom,
  detachConnection,
  evaluateRoomCleanup,
  findPlayer,
  generateId,
  generateSecret,
  isEmpty,
  isValidRoomCode,
  join,
  leave,
  setReady,
  signToken,
  toPlayerSnapshot,
  toSnapshot,
  verifyToken,
} from '@h5/game-core';
import type { PlayerRecord, RoomRecord } from '@h5/game-core';

import { createRoomRepository } from '../db/repository';
import type { RegisterRoomResult, RoomRepository } from '../db/repository';
import type { Env } from '../env';

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 房间状态在 Durable Object storage 中的键。 */
const ROOM_STORAGE_KEY = 'room';

/** 清理检查间隔。 */
const CLEANUP_INTERVAL_MS = 60_000;

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

/** 玩家操作授权结果。 */
type AuthorizationResult =
  | { readonly ok: true; readonly playerId: string; readonly player: PlayerRecord }
  | { readonly ok: false; readonly error: ProtocolError };

/** 房间实例登记结果。 */
type RoomRegistrationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'CODE_IN_USE' | 'REGISTRATION_FAILED' };

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
      hostNickname: nickname,
      authSecret,
      maxPlayers,
      now,
    });

    // 防御：确保不会持久化 / 广播「服务端自己都无法解析」的快照
    const snapshot = toSnapshot(room);
    const validated = roomSnapshotSchema.safeParse(snapshot);
    if (!validated.success) {
      console.error('[GameRoom] 创建房间产生非法快照', validated.error.issues);
      return Response.json(
        { error: ErrorCode.InvalidMessage, message: '房间参数不合法' },
        { status: 400 },
      );
    }

    // 先登记 D1 房间实例，成功后才落 DO 状态：
    // 登记失败时不留下「DO 有房间但 D1 无实例」的不一致状态。
    const registered = await this.registerRoomInstance(room, snapshot);
    if (!registered.ok) {
      return registered.reason === 'CODE_IN_USE'
        ? Response.json({ error: ErrorCode.RoomExists }, { status: 409 })
        : Response.json(
            { error: ErrorCode.InternalError, message: '房间登记失败，请重试' },
            { status: 503 },
          );
    }

    await this.persist(room);
    await this.scheduleCleanup();

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

  /**
   * 房间清理。
   *
   * 清理策略见 `evaluateRoomCleanup`：**只要还有在线玩家就永不销毁**
   * （长时间无状态变更不构成清理依据）；仅剩离线玩家时保留座位直到重连宽限期结束。
   */
  async alarm(): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      await this.destroyRoom('NO_ROOM');
      return;
    }

    const decision = evaluateRoomCleanup(room, Date.now());
    if (decision.destroy) {
      console.log(`[GameRoom] 销毁房间 ${room.roomCode}（原因：${decision.reason}）`);
      await this.destroyRoom(decision.reason ?? 'UNKNOWN');
      return;
    }

    await this.scheduleCleanup();
  }

  /* -------------------------------- 分发 --------------------------------- */

  private async dispatch(ws: WebSocket, message: ClientMessage): Promise<void> {
    // CREATE_ROOM 在房间建立之前执行，不做房间范围校验
    if (message.type === ClientMessageType.CreateRoom) {
      await this.onCreateRoom(ws, message);
      return;
    }

    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    // 封套中的 roomId / sessionId 必须与当前房间、当前对局一致；缺省按协议定义允许省略
    const scopeError = checkEnvelopeScope(message, room);
    if (scopeError) {
      this.sendError(ws, scopeError);
      return;
    }

    switch (message.type) {
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
      hostNickname: nickname,
      authSecret,
      maxPlayers,
      now,
    });

    const snapshot = toSnapshot(room);

    // 先登记 D1 房间实例，成功后才落 DO 状态（与 HTTP 创建路径一致）
    const registered = await this.registerRoomInstance(room, snapshot);
    if (!registered.ok) {
      this.sendError(
        ws,
        registered.reason === 'CODE_IN_USE'
          ? protocolError(ErrorCode.RoomExists, '房间码已被其他活动房间占用')
          : protocolError(ErrorCode.InternalError, '房间登记失败，请重试'),
      );
      return;
    }

    await this.persist(room);
    await this.scheduleCleanup();

    ws.serializeAttachment({ ...attachment, playerId: hostPlayerId });

    const token = await signToken(authSecret, roomCode, hostPlayerId);
    this.send(
      ws,
      createServerMessage(
        'SESSION_GRANTED',
        { roomCode, playerId: hostPlayerId, token, room: snapshot },
        { roomId: roomCode },
      ),
    );
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

    // 房间码仅用于定位房间（不是身份凭证），但必须与当前房间实例严格一致
    if (message.payload.roomCode !== room.roomCode) {
      this.sendError(
        ws,
        protocolError(ErrorCode.RoomNotFound, '房间码与当前房间不一致', {
          received: message.payload.roomCode,
          expected: room.roomCode,
        }),
      );
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

      // 令牌校验是异步过程，期间房间可能已被其他玩家修改。
      // 必须基于校验完成后的**最新状态**计算，否则会用过期快照覆盖并发变更。
      const latest = await this.requireRoom();
      if (!latest || latest.roomCode !== roomCode) {
        this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
        return;
      }

      const existing = findPlayer(latest, claimedPlayerId);
      if (!existing) {
        this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '玩家不存在，无法恢复'));
        return;
      }

      const attached = attachConnection(latest, claimedPlayerId, attachment.connectionId, now);
      if (!attached.ok) {
        this.sendError(ws, attached.error);
        return;
      }

      // 先落库并同步更新内存缓存（`persist` 在首个 await 之前完成赋值），
      // 使服务端连接绑定立即指向新连接；随后才关闭旧连接。
      // 这样即使旧连接仍处于关闭握手窗口内，也会因绑定不匹配而被授权校验拒绝。
      await this.persist(attached.room);
      ws.serializeAttachment({ ...attachment, playerId: claimedPlayerId });
      this.closeOtherSockets(claimedPlayerId, attachment.connectionId);

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
      await this.broadcastLatestState();
      await this.scheduleCleanup();
      return;
    }

    // 2) 新玩家
    const newPlayerId = generateId('p_');
    const result = join(room, {
      playerId: newPlayerId,
      nickname,
      connectionId: attachment.connectionId,
      now,
    });
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
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
        this.recordQuietly('玩家加入记录', () =>
          this.repository.recordPlayerJoined(result.room.instanceId, roomCode, playerSnapshot),
        ),
      );
    }

    const latest = await this.broadcastLatestState();
    if (latest) {
      this.state.waitUntil(
        this.recordQuietly('房间状态回写', () =>
          this.repository.recordRoomStatus(latest.instanceId, toSnapshot(latest)),
        ),
      );
    }
    await this.scheduleCleanup();
  }

  private async onLeaveRoom(ws: WebSocket): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const attachment = this.attachmentOf(ws);
    const auth = this.authorizePlayer(room, attachment);
    if (!auth.ok) {
      this.sendError(ws, auth.error);
      return;
    }

    const result = leave(room, auth.playerId, Date.now());
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
    ws.serializeAttachment({ ...attachment, playerId: null });

    this.broadcast(
      createServerMessage(
        'PLAYER_LEFT',
        { playerId: auth.player.playerId, nickname: auth.player.nickname, reason: 'LEFT' },
        { roomId: room.roomCode },
      ),
      attachment.connectionId,
    );
    this.state.waitUntil(
      this.recordQuietly('玩家离开记录', () =>
        this.repository.recordPlayerLeft(room.instanceId, auth.player.playerId, Date.now()),
      ),
    );

    // 房间已无玩家：立即销毁，避免遗留悬空房主身份与「永远无法开局」的空房间
    if (isEmpty(result.room)) {
      this.state.waitUntil(
        this.recordQuietly('房间状态回写', () =>
          this.repository.recordRoomStatus(result.room.instanceId, toSnapshot(result.room)),
        ),
      );
      await this.destroyRoom('EMPTY');
      return;
    }

    const latest = await this.broadcastLatestState();
    if (latest) {
      this.state.waitUntil(
        this.recordQuietly('房间状态回写', () =>
          this.repository.recordRoomStatus(latest.instanceId, toSnapshot(latest)),
        ),
      );
    }
    await this.scheduleCleanup();
  }

  private async onSetReady(ws: WebSocket, ready: boolean): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const auth = this.authorizePlayer(room, this.attachmentOf(ws));
    if (!auth.ok) {
      this.sendError(ws, auth.error);
      return;
    }

    const result = setReady(room, auth.playerId, ready, Date.now());
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);
    await this.broadcastLatestState();
    await this.scheduleCleanup();
  }

  private async onTrigger(ws: WebSocket, trigger: LifecycleTrigger): Promise<void> {
    const room = await this.requireRoom();
    if (!room) {
      this.sendError(ws, protocolError(ErrorCode.RoomNotFound, '房间不存在或已过期'));
      return;
    }

    const auth = this.authorizePlayer(room, this.attachmentOf(ws));
    if (!auth.ok) {
      this.sendError(ws, auth.error);
      return;
    }

    const previousSessionId = room.sessionId;
    const result = applyTrigger(room, trigger, auth.playerId, Date.now());
    if (!result.ok) {
      this.sendError(ws, result.error);
      return;
    }

    await this.persist(result.room);

    const now = Date.now();
    const nextSessionId = result.room.sessionId;

    if (trigger === LifecycleTrigger.Start && nextSessionId) {
      this.state.waitUntil(
        this.recordQuietly('对局开始记录', () =>
          this.repository.recordSessionStarted(
            room.instanceId,
            room.roomCode,
            room.gameId,
            nextSessionId,
            now,
          ),
        ),
      );
    }
    if (trigger === LifecycleTrigger.End && previousSessionId) {
      this.state.waitUntil(
        this.recordQuietly('对局结束记录', () =>
          this.repository.recordSessionEnded(room.instanceId, previousSessionId, now),
        ),
      );
    }

    const latest = await this.broadcastLatestState();
    if (latest) {
      this.state.waitUntil(
        this.recordQuietly('房间状态回写', () =>
          this.repository.recordRoomStatus(latest.instanceId, toSnapshot(latest)),
        ),
      );
    }
    await this.scheduleCleanup();
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

    this.broadcast(
      createServerMessage(
        'PLAYER_LEFT',
        { playerId: player.playerId, nickname: player.nickname, reason },
        { roomId: room.roomCode },
      ),
    );
    await this.broadcastLatestState();
    await this.scheduleCleanup();
  }

  /* -------------------------------- 工具 --------------------------------- */

  private roomCode(): string {
    return this.state.id.name ?? '';
  }

  private async readRoom(): Promise<RoomRecord | null> {
    const stored = await this.state.storage.get<RoomRecord>(ROOM_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    // 兼容阶段 2.3 之前持久化的房间（尚无实例标识）：补齐后回写，
    // 保证 D1 写入始终具备明确的实例归属。
    // 使用与迁移 0002 相同的回填规则（`legacy:<房间码>`），使已迁移的 D1 行与新值一致。
    if (typeof stored.instanceId === 'string' && stored.instanceId.length > 0) {
      return stored;
    }
    const upgraded: RoomRecord = { ...stored, instanceId: `legacy:${stored.roomCode}` };
    await this.state.storage.put(ROOM_STORAGE_KEY, upgraded);
    return upgraded;
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

  /**
   * 执行一次「次要」D1 写入。
   *
   * 这些记录（玩家加入/离开、对局开始结束、状态回写）都以房间实例为归属键，
   * 失败不会破坏房间状态，也不会污染其他实例；但仍必须**显式暴露**，
   * 不允许静默当成成功。
   */
  private async recordQuietly(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.error(
        `[GameRoom] D1 写入失败（${label}；房间码 ${this.cached?.roomCode ?? '未知'}，实例 ${this.cached?.instanceId ?? '未知'}）`,
        error,
      );
    }
  }

  /**
   * 登记 D1 房间实例（原子）并写入房主参与记录。
   *
   * 语义：
   * - 主键（instance_id）冲突 → 同一实例重复登记 → 幂等成功
   * - 部分唯一索引（code where ended_at is null）冲突 → 房间码仍被其他活动实例占用 → `CODE_IN_USE`
   * - 其他写入异常（例如 D1 不可用）→ `REGISTRATION_FAILED`，由调用方拒绝本次创建
   */
  private async registerRoomInstance(
    room: RoomRecord,
    snapshot: RoomSnapshot,
  ): Promise<RoomRegistrationResult> {
    let registered: RegisterRoomResult;
    try {
      registered = await this.repository.recordRoomCreated(room.instanceId, snapshot);
    } catch (error) {
      console.error(
        `[GameRoom] 房间实例登记失败（房间码 ${room.roomCode}，实例 ${room.instanceId}）`,
        error,
      );
      return { ok: false, reason: 'REGISTRATION_FAILED' };
    }

    if (!registered.ok) {
      return { ok: false, reason: 'CODE_IN_USE' };
    }

    const host = toPlayerSnapshot(room, room.hostPlayerId);
    if (host) {
      try {
        await this.repository.recordPlayerJoined(room.instanceId, room.roomCode, host);
      } catch (error) {
        // 实例已登记成功；房主参与记录是次要记录，失败在此显式暴露（不静默丢弃）
        console.error(`[GameRoom] 房主参与记录写入失败（实例 ${room.instanceId}）`, error);
      }
    }

    return { ok: true };
  }

  private attachmentOf(ws: WebSocket): SocketAttachment {
    const raw = ws.deserializeAttachment() as SocketAttachment | null;
    if (raw && typeof raw.connectionId === 'string') {
      return raw;
    }
    return { connectionId: 'unknown', playerId: null, connectedAt: 0 };
  }

  /**
   * 校验发起操作的连接是否为该玩家**当前绑定**的连接。
   *
   * 被替换的旧连接即使仍处于关闭握手窗口内，也会在此被拒绝，
   * 且不会改动房间 revision、准备状态或生命周期阶段。
   */
  private authorizePlayer(room: RoomRecord, attachment: SocketAttachment): AuthorizationResult {
    if (!attachment.playerId) {
      return { ok: false, error: protocolError(ErrorCode.NotInRoom, '当前连接尚未加入房间') };
    }

    const player = findPlayer(room, attachment.playerId);
    if (!player) {
      return {
        ok: false,
        error: protocolError(ErrorCode.NotInRoom, '玩家不在房间内', {
          playerId: attachment.playerId,
        }),
      };
    }

    if (player.connectionId !== attachment.connectionId) {
      return {
        ok: false,
        error: protocolError(ErrorCode.Unauthorized, '当前连接已被新的连接替换，操作被拒绝', {
          playerId: attachment.playerId,
        }),
      };
    }

    return { ok: true, playerId: attachment.playerId, player };
  }

  /**
   * 广播**当前最新**房间状态。
   *
   * 处理器中存在 `await`，若直接广播处理过程中捕获的旧快照，
   * 迟到的过期广播会让客户端状态回退。这里统一重新读取最新状态。
   */
  private async broadcastLatestState(): Promise<RoomRecord | null> {
    const latest = await this.requireRoom();
    if (latest) {
      this.broadcastState(latest);
    }
    return latest;
  }

  /**
   * 销毁房间：标记实例结束、关闭全部连接、清空存储与内存缓存。
   *
   * 顺序要点：
   * 1. **先**在 D1 标记该实例结束（释放房间码的活动占用），再清空 DO 存储。
   *    这样同一房间码被重新分配时，新实例不会与旧实例的活动记录冲突。
   * 2. 标记失败不会阻止销毁（房间必须可销毁）；此时旧实例行仍为「活动」，
   *    同码新建会得到 `CODE_IN_USE` 并由 Worker 换码重试 —— 失败方向是安全的。
   *
   * 标记按 `instance_id` 过滤，因此旧实例的迟到写入只会命中它自己那一行。
   */
  private async destroyRoom(reason: string): Promise<void> {
    const instanceId = this.cached?.instanceId ?? null;
    const roomCode = this.cached?.roomCode ?? '未知';

    if (instanceId) {
      try {
        await this.repository.markRoomEnded(instanceId, Date.now());
      } catch (error) {
        console.error(
          `[GameRoom] 房间实例结束标记写入失败（房间码 ${roomCode}，实例 ${instanceId}，原因 ${reason}）`,
          error,
        );
      }
    }

    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(1000, 'room closed');
      } catch {
        // 忽略已关闭的连接
      }
    }
    await this.state.storage.deleteAll();
    this.cached = null;
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
