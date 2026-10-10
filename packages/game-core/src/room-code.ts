/**
 * 房间码。
 *
 * 房间码用于**查找**房间，不是玩家身份凭证。
 * 字母表去除了易混淆字符（0/O、1/I/L），长度 6，空间约 31^6 ≈ 8.9 亿。
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 房间码长度。 */
export const ROOM_CODE_LENGTH = 6;

/** 房间码格式。 */
export const ROOM_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** 校验房间码格式。 */
export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code);
}

/**
 * 由随机字节生成房间码。
 *
 * 纯函数：随机性由调用方提供（服务端使用 Web Crypto），因此可直接单测。
 * 存在极小的取模偏差，但对「不可预测」这一要求无影响。
 */
export function generateRoomCode(randomBytes: Uint8Array): string {
  if (randomBytes.length < ROOM_CODE_LENGTH) {
    throw new Error(`生成房间码至少需要 ${ROOM_CODE_LENGTH} 字节随机数`);
  }
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const byte = randomBytes[index] ?? 0;
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}
