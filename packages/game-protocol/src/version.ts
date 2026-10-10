/** 当前协议版本号。任何不兼容的消息结构调整都必须递增该值。 */
export const PROTOCOL_VERSION = 1 as const;

/** 协议版本类型。 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;
