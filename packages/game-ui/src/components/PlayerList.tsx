import type { PlayerSnapshot } from '@h5/game-protocol';

/** 玩家列表属性。 */
export interface PlayerListProps {
  readonly players: readonly PlayerSnapshot[];
  /** 当前客户端自身的 playerId，用于高亮 */
  readonly selfPlayerId?: string | null;
}

/**
 * 玩家列表。
 *
 * 纯展示组件：只渲染服务端下发的玩家快照，不做任何本地状态推断。
 */
export function PlayerList({ players, selfPlayerId }: PlayerListProps) {
  if (players.length === 0) {
    return <p className="gui-hint">暂无玩家</p>;
  }

  return (
    <ul className="gui-players" data-testid="player-list">
      {players.map((player) => (
        <li
          key={player.playerId}
          className={
            player.playerId === selfPlayerId ? 'gui-player gui-player--self' : 'gui-player'
          }
          data-testid={`player-${player.playerId}`}
        >
          <span className="gui-player__main">
            <span className="gui-player__seat">#{player.seat + 1}</span>
            <span className="gui-player__nickname">{player.nickname}</span>
          </span>
          <span className="gui-player__tags">
            {player.isHost ? <span className="gui-tag gui-tag--host">房主</span> : null}
            {player.isHost ? null : (
              <span className={player.ready ? 'gui-tag gui-tag--ready' : 'gui-tag gui-tag--unready'}>
                {player.ready ? '已准备' : '未准备'}
              </span>
            )}
            {player.online ? null : <span className="gui-tag gui-tag--offline">离线</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
