/**
 * @h5/game-ui —— 通用游戏 UI
 *
 * 阶段 2 提供房间相关的通用组件：
 * - `RoomEntry`       创建 / 加入房间
 * - `RoomView`        房间视图（房间码、玩家列表、生命周期操作）
 * - `PlayerList`      玩家列表
 * - `ConnectionBadge` 连接状态
 *
 * 组件为纯展示 + 回调，不持有业务状态；状态由 `@h5/game-client` 提供。
 * 样式通过 `@h5/game-ui/styles.css` 引入。
 */

export { ConnectionBadge } from './components/ConnectionBadge';
export type { ConnectionBadgeProps } from './components/ConnectionBadge';

export { PlayerList } from './components/PlayerList';
export type { PlayerListProps } from './components/PlayerList';

export { RoomEntry } from './components/RoomEntry';
export type { RoomEntryProps } from './components/RoomEntry';

export { RoomView } from './components/RoomView';
export type { RoomViewProps } from './components/RoomView';
