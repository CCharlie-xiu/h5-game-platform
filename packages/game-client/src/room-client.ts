import {
  ClientMessageType,
  ErrorCode,
  createClientMessage,
  parseServerMessage,
  serializeMessage,
} from '@h5/game-protocol';
import type {
  ClientMessageType as ClientMessageTypeValue,
  ClientPayloadMap,
  ProtocolError,
  RoomSnapshot,
} from '@h5/game-protocol';

import type {
  IdentityStorage,
  RoomClientOptions,
  RoomClientSnapshot,
  RoomIdentity,
} from './types';

const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 10_000;
const SOCKET_OPEN = 1;

type Listener = (snapshot: RoomClientSnapshot) => void;

interface CreateRoomResponse {
  readonly roomCode: string;
  readonly playerId: string;
  readonly token: string;
  readonly room: RoomSnapshot;
}

function toProtocolError(error: unknown, fallback: string): ProtocolError {
  if (error instanceof Error) {
    return { code: ErrorCode.InternalError, message: error.message };
  }
  return { code: ErrorCode.InternalError, message: fallback };
}

/**
 * 房间客户端。
 *
 * 职责：
 * - 建立 / 维护 WebSocket 连接
 * - 断线后自动重连，并携带服务端签发的身份令牌恢复座位
 * - 只消费服务端下发的权威 `ROOM_STATE`，**不**在本地模拟状态
 *
 * 所有对外状态通过 `getSnapshot()` / `subscribe()` 暴露。
 */
export class RoomClient {
  private readonly baseUrl: string;
  private readonly storage: IdentityStorage | null;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly webSocketFactory: (url: string) => WebSocket;

  private socket: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private snapshot: RoomClientSnapshot = {
    status: 'idle',
    identity: null,
    room: null,
    lastError: null,
    reconnectAttempts: 0,
  };

  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentRoomCode: string | null = null;
  private nickname = '';

  constructor(options: RoomClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.storage = options.storage ?? null;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  /* ------------------------------ 订阅 / 快照 ----------------------------- */

  /** 当前快照（引用稳定，可用于 React `useSyncExternalStore`）。 */
  getSnapshot(): RoomClientSnapshot {
    return this.snapshot;
  }

  /** 订阅状态变化，返回取消订阅函数。订阅时会立即回调一次。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private patch(partial: Partial<RoomClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  /* --------------------------------- 动作 -------------------------------- */

  /** 创建房间：POST /api/rooms → 建立 WebSocket → 以房主身份加入。 */
  async createRoom(params: {
    gameId: string;
    nickname: string;
    maxPlayers?: number;
  }): Promise<void> {
    this.teardownSocket();
    this.patch({ status: 'connecting', room: null, lastError: null, reconnectAttempts: 0 });

    try {
      const response = await fetch(`${this.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`创建房间失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
      }

      const data = (await response.json()) as CreateRoomResponse;
      const identity: RoomIdentity = {
        roomCode: data.roomCode,
        playerId: data.playerId,
        token: data.token,
        nickname: params.nickname,
      };

      this.storage?.save(identity);
      this.nickname = params.nickname;
      this.currentRoomCode = identity.roomCode;
      this.patch({ identity, room: data.room });
      this.openSocket(identity.roomCode, identity, params.nickname);
    } catch (error) {
      this.patch({ status: 'idle', lastError: toProtocolError(error, '创建房间失败') });
      throw error;
    }
  }

  /** 加入房间。若本地存有该房间的身份，则按重连处理。 */
  joinRoom(params: { roomCode: string; nickname: string }): void {
    this.teardownSocket();

    const roomCode = params.roomCode.trim().toUpperCase();
    const stored = this.storage?.load() ?? null;
    const identity = stored && stored.roomCode === roomCode ? stored : null;

    this.nickname = params.nickname;
    this.currentRoomCode = roomCode;
    this.patch({ status: 'connecting', identity, room: null, lastError: null, reconnectAttempts: 0 });
    this.openSocket(roomCode, identity, params.nickname);
  }

  /** 主动离开房间（同时清除本地身份）。 */
  leaveRoom(): void {
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      this.sendMessage(ClientMessageType.LeaveRoom, {});
    }
    this.storage?.clear();
    this.disconnect();
    this.patch({ identity: null, room: null });
  }

  /** 断开连接（保留本地身份，便于刷新后恢复）。 */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.closeSocket();
    this.patch({ status: 'closed', room: null });
  }

  /** 准备。 */
  setReady(): void {
    this.sendMessage(ClientMessageType.PlayerReady, {});
  }

  /** 取消准备。 */
  setUnready(): void {
    this.sendMessage(ClientMessageType.PlayerUnready, {});
  }

  /** 房主开始游戏。 */
  startGame(): void {
    this.sendMessage(ClientMessageType.GameStart, {});
  }

  /** 房主暂停游戏。 */
  pauseGame(): void {
    this.sendMessage(ClientMessageType.GamePause, {});
  }

  /** 房主继续游戏。 */
  resumeGame(): void {
    this.sendMessage(ClientMessageType.GameResume, {});
  }

  /** 房主结束对局。 */
  endGame(): void {
    this.sendMessage(ClientMessageType.GameEnd, {});
  }

  /* -------------------------------- 内部 -------------------------------- */

  private wsBase(): string {
    if (this.baseUrl) {
      return this.baseUrl.replace(/^http/, 'ws');
    }
    if (typeof window !== 'undefined') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}`;
    }
    return 'ws://127.0.0.1:8787';
  }

  private openSocket(
    roomCode: string,
    identity: RoomIdentity | null,
    nickname: string,
  ): void {
    this.closeSocket();
    this.intentionalClose = false;

    const url = `${this.wsBase()}/api/rooms/${roomCode}/ws`;
    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(url);
    } catch (error) {
      this.patch({ status: 'closed', lastError: toProtocolError(error, 'WebSocket 建立失败') });
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.patch({ status: 'connected', reconnectAttempts: 0, lastError: null });
      this.sendMessage(ClientMessageType.JoinRoom, {
        roomCode,
        nickname: nickname || '玩家',
        ...(identity ? { playerId: identity.playerId, token: identity.token } : {}),
      });
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.intentionalClose) {
        this.patch({ status: 'closed' });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      return;
    }

    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.patch({ lastError: parsed.error });
      return;
    }

    const message = parsed.message;
    switch (message.type) {
      case 'SESSION_GRANTED': {
        const identity: RoomIdentity = {
          roomCode: message.payload.roomCode,
          playerId: message.payload.playerId,
          token: message.payload.token,
          ...(this.nickname ? { nickname: this.nickname } : {}),
        };
        this.storage?.save(identity);
        this.currentRoomCode = identity.roomCode;
        this.patch({ identity, room: message.payload.room, lastError: null });
        return;
      }
      case 'ROOM_STATE': {
        this.patch({ room: message.payload.room });
        return;
      }
      case 'SYSTEM_ERROR': {
        this.patch({
          lastError: {
            code: message.payload.code as ProtocolError['code'],
            message: message.payload.message,
            ...(message.payload.details ? { details: message.payload.details } : {}),
          },
        });
        return;
      }
      default:
        return;
    }
  }

  private sendMessage<K extends ClientMessageTypeValue>(
    type: K,
    payload: ClientPayloadMap[K],
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.patch({
        lastError: { code: ErrorCode.InternalError, message: '连接尚未就绪，操作未发送' },
      });
      return;
    }
    const message = createClientMessage(type, payload, {
      ...(this.currentRoomCode ? { roomId: this.currentRoomCode } : {}),
    });
    socket.send(serializeMessage(message));
  }

  private scheduleReconnect(): void {
    const attempts = this.snapshot.reconnectAttempts + 1;
    const identity = this.snapshot.identity;

    if (!identity || attempts > this.maxReconnectAttempts) {
      this.patch({ status: 'closed', reconnectAttempts: attempts });
      return;
    }

    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** (attempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.patch({ status: 'reconnecting', reconnectAttempts: attempts });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const current = this.snapshot.identity;
      if (!current) {
        return;
      }
      this.openSocket(current.roomCode, current, this.nickname);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }

  private teardownSocket(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.closeSocket();
  }
}

/** 基于 `localStorage` 的身份存储（浏览器环境）。 */
export function createLocalStorageIdentityStore(key = 'h5gp.room.identity'): IdentityStorage {
  return {
    load() {
      if (typeof localStorage === 'undefined') {
        return null;
      }
      const raw = localStorage.getItem(key);
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as Partial<RoomIdentity>;
        if (
          typeof parsed.roomCode === 'string' &&
          typeof parsed.playerId === 'string' &&
          typeof parsed.token === 'string'
        ) {
          return {
            roomCode: parsed.roomCode,
            playerId: parsed.playerId,
            token: parsed.token,
            ...(typeof parsed.nickname === 'string' ? { nickname: parsed.nickname } : {}),
          };
        }
      } catch {
        // 忽略损坏数据
      }
      return null;
    },
    save(identity) {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(key, JSON.stringify(identity));
    },
    clear() {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.removeItem(key);
    },
  };
}
