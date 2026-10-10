/**
 * @h5/game-core —— 游戏生命周期与房间领域逻辑
 *
 * - `lifecycle` 生命周期阶段、合法转换表与拒绝规则（纯函数）
 * - `room`      房间状态模型与纯函数操作（加入 / 离开 / 准备 / 开始 / 暂停 / 继续 / 结束）
 * - `room-code` 房间码生成与校验
 * - `identity`  随机标识、房间级密钥与 HMAC 身份令牌
 *
 * 本包不依赖任何宿主框架（Workers / 浏览器 / Node），可在任意环境与测试中直接使用。
 */

export * from './identity';
export * from './lifecycle';
export * from './room';
export * from './room-code';
