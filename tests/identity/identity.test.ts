import {
  ROOM_CODE_LENGTH,
  generateId,
  generateRandomBytes,
  generateRoomCode,
  isValidRoomCode,
  signToken,
  timingSafeEqualHex,
  verifyToken,
} from '@h5/game-core';
import { describe, expect, it } from 'vitest';

describe('身份：随机标识', () => {
  it('generateId 带前缀且长度符合预期', () => {
    const id = generateId('p_', 16);
    expect(id.startsWith('p_')).toBe(true);
    expect(id).toHaveLength(2 + 32);
  });

  it('大量生成的标识不重复', () => {
    const ids = new Set(Array.from({ length: 300 }, () => generateId('c_', 8)));
    expect(ids.size).toBe(300);
  });

  it('generateRandomBytes 返回指定长度', () => {
    expect(generateRandomBytes(8)).toHaveLength(8);
  });
});

describe('身份：HMAC 令牌', () => {
  it('相同输入产生相同令牌', async () => {
    const first = await signToken('secret', 'ABC234', 'p_1');
    const second = await signToken('secret', 'ABC234', 'p_1');
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it('正确令牌校验通过', async () => {
    const token = await signToken('secret', 'ABC234', 'p_1');
    await expect(verifyToken('secret', 'ABC234', 'p_1', token)).resolves.toBe(true);
  });

  it('密钥 / 房间 / 玩家任一不同都校验失败', async () => {
    const token = await signToken('secret', 'ABC234', 'p_1');
    await expect(verifyToken('other-secret', 'ABC234', 'p_1', token)).resolves.toBe(false);
    await expect(verifyToken('secret', 'ZZZ999', 'p_1', token)).resolves.toBe(false);
    await expect(verifyToken('secret', 'ABC234', 'p_2', token)).resolves.toBe(false);
  });

  it('伪造令牌校验失败', async () => {
    const forged = 'f'.repeat(64);
    await expect(verifyToken('secret', 'ABC234', 'p_1', forged)).resolves.toBe(false);
  });

  it('常量时间比较', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
  });
});

describe('房间码', () => {
  it('生成结果长度与格式合法', () => {
    const code = generateRoomCode(generateRandomBytes(8));
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    expect(isValidRoomCode(code)).toBe(true);
  });

  it('不包含易混淆字符 0 / 1 / O / I / L', () => {
    for (let index = 0; index < 300; index += 1) {
      expect(generateRoomCode(generateRandomBytes(8))).not.toMatch(/[01OIL]/);
    }
  });

  it('格式校验', () => {
    expect(isValidRoomCode('ABC234')).toBe(true);
    expect(isValidRoomCode('abc234')).toBe(false);
    expect(isValidRoomCode('ABC23')).toBe(false);
    expect(isValidRoomCode('ABC10O')).toBe(false);
  });

  it('随机字节不足时抛错', () => {
    expect(() => generateRoomCode(new Uint8Array(2))).toThrow();
  });
});
