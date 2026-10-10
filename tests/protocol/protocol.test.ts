import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '@h5/game-protocol';
import type { BaseMessage } from '@h5/game-protocol';

describe('@h5/game-protocol', () => {
  it('协议版本为正整数', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('消息信封可携带类型化负载', () => {
    const message: BaseMessage<'ping', { at: number }> = {
      type: 'ping',
      version: PROTOCOL_VERSION,
      payload: { at: 1 },
    };

    expect(message.type).toBe('ping');
    expect(message.payload.at).toBe(1);
  });
});
