import type { RoomClientStatus } from '@h5/game-client';
import { LifecycleTrigger, allowedTriggers } from '@h5/game-core';
import type { GamePhase as GamePhaseValue, RoomSnapshot } from '@h5/game-protocol';

import { ConnectionBadge } from './ConnectionBadge';
import { PlayerList } from './PlayerList';

/** 阶段中文名。 */
const PHASE_LABELS: Record<GamePhaseValue, string> = {
  WAITING: '等待玩家',
  READY: '准备就绪',
  PLAYING: '游戏进行中',
  PAUSED: '已暂停',
  FINISHED: '已结束',
};

/** 房间视图属性。 */
export interface RoomViewProps {
  readonly room: RoomSnapshot;
  readonly status: RoomClientStatus;
  readonly reconnectAttempts?: number;
  readonly selfPlayerId: string | null;
  readonly onToggleReady: (ready: boolean) => void;
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onEnd: () => void;
  readonly onLeave: () => void;
}

/**
 * 房间视图。
 *
 * 所有按钮可用性都由「服务端权威阶段 + 转换表」推导，
 * 客户端不自行模拟状态；点击后仍需等待服务端广播。
 */
export function RoomView({
  room,
  status,
  reconnectAttempts = 0,
  selfPlayerId,
  onToggleReady,
  onStart,
  onPause,
  onResume,
  onEnd,
  onLeave,
}: RoomViewProps) {
  const self = room.players.find((player) => player.playerId === selfPlayerId) ?? null;
  const isHost = self?.isHost ?? false;

  const allowed = allowedTriggers(room.phase);
  const canStart = isHost && allowed.includes(LifecycleTrigger.Start);
  const canPause = isHost && allowed.includes(LifecycleTrigger.Pause);
  const canResume = isHost && allowed.includes(LifecycleTrigger.Resume);
  const canEnd = isHost && allowed.includes(LifecycleTrigger.End);
  const canToggleReady =
    self !== null && !isHost && (room.phase === 'WAITING' || room.phase === 'READY');

  const onlineCount = room.players.filter((player) => player.online).length;

  return (
    <div className="gui-room">
      <div className="gui-room__header">
        <div className="gui-room__code">
          <span className="gui-room__code-label">房间码</span>
          <span className="gui-room__code-value" data-testid="room-code">
            {room.roomCode}
          </span>
        </div>
        <div className="gui-player__tags">
          <span className={`gui-phase gui-phase--${room.phase.toLowerCase()}`} data-testid="room-phase">
            {PHASE_LABELS[room.phase]}
          </span>
          <ConnectionBadge status={status} reconnectAttempts={reconnectAttempts} />
        </div>
      </div>

      <p className="gui-hint" data-testid="room-meta">
        {room.gameId} · {onlineCount}/{room.maxPlayers} 在线 · 最少 {room.minPlayers} 人开局 · 状态版本 v
        {room.revision}
        {room.sessionId ? ` · 对局 ${room.sessionId}` : ''}
      </p>

      <PlayerList players={room.players} selfPlayerId={selfPlayerId} />

      <div className="gui-actions">
        {canToggleReady ? (
          <button
            type="button"
            data-testid="btn-ready"
            className="gui-button gui-button--primary"
            onClick={() => onToggleReady(!(self?.ready ?? false))}
          >
            {self?.ready ? '取消准备' : '准备'}
          </button>
        ) : null}

        <button
          type="button"
          data-testid="btn-start"
          className="gui-button gui-button--primary"
          disabled={!canStart}
          onClick={onStart}
        >
          开始游戏
        </button>

        <button
          type="button"
          data-testid="btn-pause"
          className="gui-button"
          disabled={!canPause}
          onClick={onPause}
        >
          暂停
        </button>

        <button
          type="button"
          data-testid="btn-resume"
          className="gui-button"
          disabled={!canResume}
          onClick={onResume}
        >
          继续
        </button>

        <button
          type="button"
          data-testid="btn-end"
          className="gui-button gui-button--danger"
          disabled={!canEnd}
          onClick={onEnd}
        >
          结束对局
        </button>

        <button type="button" data-testid="btn-leave" className="gui-button" onClick={onLeave}>
          离开房间
        </button>
      </div>

      {!isHost && room.phase === 'WAITING' ? (
        <p className="gui-hint">等待玩家加入；房主将在人数与准备条件满足后开始游戏。</p>
      ) : null}
      {isHost && room.phase === 'WAITING' ? (
        <p className="gui-hint">
          还差 {Math.max(room.minPlayers - room.players.length, 0)} 人达到开局人数。
        </p>
      ) : null}
      {room.phase === 'PLAYING' || room.phase === 'PAUSED' ? (
        <p className="gui-hint">
          游戏已开始，具体玩法与动画属于后续阶段；当前仅同步统一的房间生命周期状态。
        </p>
      ) : null}
    </div>
  );
}
