/**
 * 身份工具：随机标识、密钥与 HMAC 令牌。
 *
 * 仅依赖 Web Crypto（Cloudflare Workers / Node 18+ / 浏览器均提供），
 * 不依赖任何宿主框架，因此可直接单测。
 *
 * 设计要点：
 * - `playerId` 是**稳定身份**，由服务端签发
 * - `connectionId` 是**单次连接标识**，每次 WebSocket 连接都会更换
 * - `token` 是服务端用房间级密钥签发的 HMAC，用于重连时证明身份
 * - 房间码**不是**身份凭证
 */

interface CryptoKeyLike {
  readonly __cryptoKey: unique symbol;
}

interface SubtleCryptoLike {
  importKey(
    format: string,
    keyData: Uint8Array,
    algorithm: { name: string; hash: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  sign(algorithm: { name: string }, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
}

interface CryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle: SubtleCryptoLike;
}

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}

/**
 * 通过 `globalThis` 取值而非声明全局变量：
 * 本包会被不同 tsconfig（Workers / DOM）编译，声明全局会与宿主类型冲突。
 */
const webCrypto = (globalThis as unknown as { crypto: CryptoLike }).crypto;

const encoder: TextEncoderLike = new (
  globalThis as unknown as { TextEncoder: new () => TextEncoderLike }
).TextEncoder();

/** 字节数组转小写十六进制。 */
export function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

/** 生成指定长度的安全随机字节。 */
export function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  webCrypto.getRandomValues(bytes);
  return bytes;
}

/** 生成带前缀的随机标识，例如 `p_9f3a...`。 */
export function generateId(prefix: string, byteLength = 16): string {
  return `${prefix}${toHex(generateRandomBytes(byteLength))}`;
}

/** 生成房间级 HMAC 密钥（十六进制字符串）。 */
export function generateSecret(byteLength = 32): string {
  return toHex(generateRandomBytes(byteLength));
}

/** 常量时间比较两个十六进制字符串，避免时序侧信道。 */
export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacKey(secret: string): Promise<CryptoKeyLike> {
  return webCrypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * 为 `scope:subject` 签发 HMAC 令牌。
 *
 * @param secret 房间级密钥
 * @param scope  作用域，使用房间码
 * @param subject 主体，使用 playerId
 */
export async function signToken(secret: string, scope: string, subject: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await webCrypto.subtle.sign(
    { name: 'HMAC' },
    key,
    encoder.encode(`${scope}:${subject}`),
  );
  return toHex(new Uint8Array(signature));
}

/** 校验令牌是否由 `secret` 为 `scope:subject` 签发。 */
export async function verifyToken(
  secret: string,
  scope: string,
  subject: string,
  token: string,
): Promise<boolean> {
  const expected = await signToken(secret, scope, subject);
  return timingSafeEqualHex(expected, token);
}
