import { PROTOCOL_VERSION, createMessageId } from '@h5/game-protocol';
import type { ServerMessage } from '@h5/game-protocol';
import { SELF, env } from 'cloudflare:test';
import { expect } from 'vitest';

const BASE = 'https://example.com';

/** POST /api/rooms 的响应。 */
export interface CreatedRoom {
  readonly roomCode: string;
  readonly playerId: string;
  readonly token: string;
  readonly room: {
    readonly roomCode: string;
    readonly phase: string;
    readonly players: ReadonlyArray<{ readonly playerId: string; readonly nickname: string }>;
  };
}

/** 创建房间。 */
export async function createRoom(nickname: string, maxPlayers?: number): Promise<CreatedRoom> {
  const response = await SELF.fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId: 'diffusion-master',
      nickname,
      ...(maxPlayers === undefined ? {} : { maxPlayers }),
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CreatedRoom;
}

/** 读取房间快照。 */
export async function fetchSnapshot(roomCode: string): Promise<{ status: number; body: unknown }> {
  const response = await SELF.fetch(`${BASE}/api/rooms/${roomCode}`);
  return { status: response.status, body: await response.json() };
}

/** 读取房间当前 revision（用于断言「被拒绝的操作没有改动状态」）。 */
export async function revisionOf(roomCode: string): Promise<number> {
  const snapshot = await fetchSnapshot(roomCode);
  const body = snapshot.body as { room: { revision: number } };
  return body.room.revision;
}

/** 以原始请求体调用 POST /api/rooms（用于校验非法入参被入口拒绝）。 */
export async function postCreateRoom(
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await SELF.fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** 取得房间对应的 Durable Object stub（用于 alarm / 逐出 / 直接调用实例方法）。 */
export function roomStub(roomCode: string): DurableObjectStub {
  const bindings = env as unknown as { GAME_ROOM: DurableObjectNamespace };
  return bindings.GAME_ROOM.get(bindings.GAME_ROOM.idFromName(roomCode));
}

/** 轮询直到房间被销毁（`GET /api/rooms/:code` 返回 404）。 */
export async function waitForRoomGone(roomCode: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await fetchSnapshot(roomCode);
    if (snapshot.status === 404) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待房间 ${roomCode} 销毁超时（当前状态 ${snapshot.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** WebSocket 测试封装：按消息类型等待，未消费的消息进入队列。 */
export class RoomSocket {
  private readonly socket: WebSocket;
  private readonly pending: ServerMessage[] = [];
  private waiters: Array<{
    type: string;
    resolve: (message: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closed = false;
  private closeWaiters: Array<() => void> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      this.push(JSON.parse(String(event.data)) as ServerMessage);
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      const waiters = this.closeWaiters;
      this.closeWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    });
  }

  /** 客户端侧是否已观察到连接关闭。 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 等待连接被关闭（例如被服务端作为「旧连接」替换时）。 */
  waitForClose(timeoutMs = 4000): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onClose = () => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve();
      };
      timer = setTimeout(() => {
        this.closeWaiters = this.closeWaiters.filter((waiter) => waiter !== onClose);
        reject(new Error('等待连接关闭超时'));
      }, timeoutMs);
      this.closeWaiters.push(onClose);
    });
  }

  private push(message: ServerMessage): void {
    const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
    const waiter = index >= 0 ? this.waiters.splice(index, 1)[0] : undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.pending.push(message);
  }

  /** 等待指定类型的消息。 */
  waitFor<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const index = this.pending.findIndex((message) => message.type === type);
    if (index >= 0) {
      const [message] = this.pending.splice(index, 1);
      return Promise.resolve(message as Extract<ServerMessage, { type: T }>);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        const seen = this.pending.map((message) => message.type).join(', ') || '无';
        reject(new Error(`等待 ${type} 超时；已收到：${seen}`));
      }, timeoutMs);
      this.waiters.push({ type, resolve: resolve as (message: ServerMessage) => void, timer });
    });
  }

  /** 等待满足条件的 ROOM_STATE。 */
  async waitForState(
    predicate: (room: Record<string, unknown>) => boolean,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('等待 ROOM_STATE 超时');
      }
      const message = await this.waitFor('ROOM_STATE', remaining);
      const room = message.payload.room as unknown as Record<string, unknown>;
      if (predicate(room)) {
        return room;
      }
    }
  }

  /** 发送一条协议消息，返回 messageId。可显式指定封套中的 roomId / sessionId。 */
  send(
    type: string,
    payload: unknown,
    messageId = createMessageId(),
    envelope: { roomId?: string; sessionId?: string } = {},
  ): string {
    this.socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        messageId,
        type,
        ...(envelope.roomId === undefined ? {} : { roomId: envelope.roomId }),
        ...(envelope.sessionId === undefined ? {} : { sessionId: envelope.sessionId }),
        payload,
      }),
    );
    return messageId;
  }

  /** 发送原始文本（用于非法消息测试）。 */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // 忽略
    }
  }
}

/** 建立到房间的 WebSocket 连接。 */
export async function connectSocket(roomCode: string): Promise<RoomSocket> {
  const response = await SELF.fetch(`${BASE}/api/rooms/${roomCode}/ws`, {
    headers: { Upgrade: 'websocket' },
  });
  const socket = response.webSocket;
  if (!socket) {
    throw new Error('WebSocket 升级失败');
  }
  socket.accept();
  return new RoomSocket(socket);
}

/** 房主创建并进入房间。 */
export async function setupHost(nickname = '房主') {
  const created = await createRoom(nickname);
  const socket = await connectSocket(created.roomCode);
  socket.send('JOIN_ROOM', {
    roomCode: created.roomCode,
    nickname,
    playerId: created.playerId,
    token: created.token,
  });
  const granted = await socket.waitFor('SESSION_GRANTED');
  return { created, socket, granted };
}

/** 以新玩家身份加入房间。 */
export async function joinAsPlayer(roomCode: string, nickname: string) {
  const socket = await connectSocket(roomCode);
  socket.send('JOIN_ROOM', { roomCode, nickname });
  const granted = await socket.waitFor('SESSION_GRANTED');
  return { socket, granted };
}

/** 从玩家列表中取昵称集合。 */
export function nicknames(room: Record<string, unknown>): string[] {
  const players = (room.players ?? []) as ReadonlyArray<{ nickname: string }>;
  return players.map((player) => player.nickname).sort();
}
