import { useState } from 'react';

/** 房间入口属性。 */
export interface RoomEntryProps {
  readonly gameId: string;
  readonly disabled?: boolean;
  readonly onCreate: (params: { gameId: string; nickname: string }) => void;
  readonly onJoin: (params: { roomCode: string; nickname: string }) => void;
}

/** 创建 / 加入房间入口。 */
export function RoomEntry({ gameId, disabled = false, onCreate, onJoin }: RoomEntryProps) {
  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const trimmedNickname = nickname.trim();
  const trimmedCode = roomCode.trim().toUpperCase();
  const canSubmit = !disabled && trimmedNickname.length > 0;

  return (
    <div className="gui-entry">
      <div className="gui-field">
        <label htmlFor="gui-nickname">昵称</label>
        <input
          id="gui-nickname"
          data-testid="input-nickname"
          className="gui-input"
          value={nickname}
          maxLength={24}
          placeholder="输入昵称"
          disabled={disabled}
          onChange={(event) => setNickname(event.target.value)}
        />
      </div>

      <div className="gui-actions">
        <button
          type="button"
          data-testid="btn-create-room"
          className="gui-button gui-button--primary"
          disabled={!canSubmit}
          onClick={() => onCreate({ gameId, nickname: trimmedNickname })}
        >
          创建房间
        </button>
      </div>

      <div className="gui-field">
        <label htmlFor="gui-room-code">房间码</label>
        <input
          id="gui-room-code"
          data-testid="input-room-code"
          className="gui-input gui-input--code"
          value={roomCode}
          maxLength={6}
          placeholder="例如 7KQ2MP"
          disabled={disabled}
          onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
        />
      </div>

      <div className="gui-actions">
        <button
          type="button"
          data-testid="btn-join-room"
          className="gui-button"
          disabled={!canSubmit || trimmedCode.length !== 6}
          onClick={() => onJoin({ roomCode: trimmedCode, nickname: trimmedNickname })}
        >
          加入房间
        </button>
      </div>

      <p className="gui-hint">房间码由服务端生成，仅用于查找房间，不是身份凭证。</p>
    </div>
  );
}
