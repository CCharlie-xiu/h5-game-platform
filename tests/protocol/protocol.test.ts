import { describe, expect, it } from 'vitest';

import {
  ClientMessageType,
  ErrorCode,
  PROTOCOL_VERSION,
  createClientMessage,
  createServerMessage,
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
} from '@h5/game-protocol';
import type { RoomSnapshot } from '@h5/game-protocol';

function envelope(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'm-1',
    type,
    payload,
    ...overrides,
  });
}

const roomSnapshot: RoomSnapshot = {
  roomId: 'ABC123',
  roomCode: 'ABC123',
  gameId: 'diffusion-master',
  phase: 'WAITING',
  hostPlayerId: 'p_1',
  minPlayers: 2,
  maxPlayers: 4,
  sessionId: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
  players: [
    {
      playerId: 'p_1',
      nickname: '房主',
      isHost: true,
      ready: false,
      online: true,
      seat: 0,
      joinedAt: 1,
    },
  ],
};

describe('@h5/game-protocol 版本', () => {
  it('协议版本为正整数', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('parseClientMessage', () => {
  it('接受合法的 CREATE_ROOM', () => {
    const result = parseClientMessage(
      envelope(ClientMessageType.CreateRoom, { gameId: 'g', nickname: 'A' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('CREATE_ROOM');
      expect(result.message.payload).toEqual({ gameId: 'g', nickname: 'A' });
    }
  });

  it('拒绝非法 JSON', () => {
    const result = parseClientMessage('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.InvalidMessage);
    }
  });

  it('拒绝协议版本不匹配', () => {
    const result = parseClientMessage(
      envelope(ClientMessageType.PlayerReady, {}, { protocolVersion: PROTOCOL_VERSION + 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.ProtocolVersionMismatch);
    }
  });

  it('拒绝未知消息类型', () => {
    const result = parseClientMessage(envelope('NOT_A_TYPE', {}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.UnknownMessageType);
    }
  });

  it('拒绝服务端消息类型作为请求', () => {
    const result = parseClientMessage(envelope('ROOM_STATE', { room: roomSnapshot }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.UnknownMessageType);
    }
  });

  it('拒绝缺少必填字段的负载', () => {
    const result = parseClientMessage(envelope(ClientMessageType.CreateRoom, { gameId: 'g' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.InvalidMessage);
    }
  });

  it('拒绝负载中的多余字段（strict schema）', () => {
    const result = parseClientMessage(
      envelope(ClientMessageType.JoinRoom, { roomCode: 'ABCD', nickname: 'A', extra: 1 }),
    );
    expect(result.ok).toBe(false);
  });

  it('拒绝类型错误的负载字段', () => {
    const result = parseClientMessage(
      envelope(ClientMessageType.CreateRoom, { gameId: 'g', nickname: 'A', maxPlayers: 'many' }),
    );
    expect(result.ok).toBe(false);
  });

  it('接受空负载动作', () => {
    const result = parseClientMessage(envelope(ClientMessageType.GameStart, {}));
    expect(result.ok).toBe(true);
  });

  it('接受带 roomId 的请求', () => {
    const result = parseClientMessage(
      envelope(ClientMessageType.PlayerReady, {}, { roomId: 'ABC123' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.roomId).toBe('ABC123');
    }
  });
});

describe('parseServerMessage', () => {
  it('接受合法的 ROOM_STATE', () => {
    const result = parseServerMessage(envelope('ROOM_STATE', { room: roomSnapshot }));
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'ROOM_STATE') {
      expect(result.message.payload.room.roomCode).toBe('ABC123');
    }
  });

  it('拒绝负载结构错误的 ROOM_STATE', () => {
    const result = parseServerMessage(envelope('ROOM_STATE', { room: { roomId: 'X' } }));
    expect(result.ok).toBe(false);
  });

  it('拒绝客户端消息类型作为广播', () => {
    const result = parseServerMessage(envelope('GAME_START', {}));
    expect(result.ok).toBe(false);
  });
});

describe('构造与序列化', () => {
  it('createClientMessage 生成唯一 messageId 且可被重新解析', () => {
    const a = createClientMessage(ClientMessageType.PlayerReady, {});
    const b = createClientMessage(ClientMessageType.PlayerReady, {});
    expect(a.messageId).not.toBe(b.messageId);
    expect(a.protocolVersion).toBe(PROTOCOL_VERSION);

    const parsed = parseClientMessage(serializeMessage(a));
    expect(parsed.ok).toBe(true);
  });

  it('createServerMessage 可携带 roomId 与 sessionId', () => {
    const message = createServerMessage(
      'PLAYER_JOINED',
      {
        player: {
          playerId: 'p_2',
          nickname: 'B',
          isHost: false,
          ready: false,
          online: true,
          seat: 1,
          joinedAt: 2,
        },
      },
      { roomId: 'ABC123', sessionId: 's_1' },
    );
    expect(message.roomId).toBe('ABC123');
    expect(message.sessionId).toBe('s_1');

    const parsed = parseServerMessage(serializeMessage(message));
    expect(parsed.ok).toBe(true);
  });

  it('缺省时封套不包含 roomId / sessionId 字段', () => {
    const message = createClientMessage(ClientMessageType.PlayerReady, {});
    expect('roomId' in message).toBe(false);
    expect('sessionId' in message).toBe(false);
  });
});
