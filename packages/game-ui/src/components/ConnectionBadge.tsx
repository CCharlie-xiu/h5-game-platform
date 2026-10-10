import type { RoomClientStatus } from '@h5/game-client';

/** 连接状态徽标属性。 */
export interface ConnectionBadgeProps {
  readonly status: RoomClientStatus;
  /** 已重连次数（仅 reconnecting 时展示） */
  readonly reconnectAttempts?: number;
}

const LABELS: Record<RoomClientStatus, string> = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  closed: '已断开',
};

/** 连接状态徽标。 */
export function ConnectionBadge({ status, reconnectAttempts = 0 }: ConnectionBadgeProps) {
  const suffix = status === 'reconnecting' && reconnectAttempts > 0 ? `（第 ${reconnectAttempts} 次）` : '';
  return (
    <span className={`gui-badge gui-badge--${status}`} data-testid="connection-status" data-status={status}>
      {LABELS[status]}
      {suffix}
    </span>
  );
}
