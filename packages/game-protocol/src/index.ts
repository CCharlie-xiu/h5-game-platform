/**
 * @h5/game-protocol —— 统一消息协议
 *
 * - `version`    协议版本
 * - `phase`      生命周期阶段（协议层权威定义）
 * - `snapshots`  房间 / 玩家权威快照
 * - `messages`   消息类型、封套、负载 Schema、解析与构造
 * - `errors`     协议错误码
 *
 * 所有入站消息必须经过 `parseClientMessage` / `parseServerMessage` 校验。
 */

export * from './errors';
export * from './messages';
export * from './phase';
export * from './snapshots';
export * from './version';
