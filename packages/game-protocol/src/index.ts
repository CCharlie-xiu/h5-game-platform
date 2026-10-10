/**
 * @h5/game-protocol —— 统一消息协议
 *
 * 阶段 1 仅定义协议版本与最小消息信封。
 * 具体消息类型（房间、对局、同步、结算）在后续阶段补充。
 */

/** 当前协议版本号。任何不兼容的消息结构调整都必须递增该值。 */
export const PROTOCOL_VERSION = 1 as const;

/** 协议版本类型。 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** 所有客户端 / 服务端消息共用的最小信封结构。 */
export interface BaseMessage<TType extends string = string, TPayload = unknown> {
  /** 消息类型标识，后续阶段由具体消息常量收敛。 */
  readonly type: TType;
  /** 协议版本，用于握手期版本协商。 */
  readonly version: ProtocolVersion;
  /** 消息负载。 */
  readonly payload: TPayload;
}
