import { implemented as diffusionMasterImplemented, manifest as diffusionMaster } from '@h5/diffusion-master';
import { RoomEntry, RoomView } from '@h5/game-ui';
import { useEffect, useState } from 'react';
import { version as reactVersion } from 'react';

import { GameCanvas } from './components/GameCanvas';
import { identityStore, useRoomClient } from './hooks/useRoomClient';
import { fetchHealth } from './lib/api';
import type { HealthResult } from './lib/api';
import { getRuntimeInfo } from './lib/runtime';

type HealthState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'settled'; readonly result: HealthResult };

/** 阶段 2 首页：通用房间系统（创建 / 加入 / 准备 / 开始 / 暂停 / 继续 / 结束）。 */
export function App() {
  const runtime = getRuntimeInfo();
  const { client, snapshot } = useRoomClient();
  const [health, setHealth] = useState<HealthState>({ phase: 'loading' });
  const [storedIdentity] = useState(() => identityStore.load());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal).then((result) => {
      setHealth({ phase: 'settled', result });
    });
    return () => {
      controller.abort();
    };
  }, []);

  const handleCreate = (params: { gameId: string; nickname: string }) => {
    setBusy(true);
    void client
      .createRoom(params)
      .catch(() => {
        /* 错误已写入 snapshot.lastError */
      })
      .finally(() => setBusy(false));
  };

  const handleJoin = (params: { roomCode: string; nickname: string }) => {
    client.joinRoom(params);
  };

  const handleResume = () => {
    if (!storedIdentity) {
      return;
    }
    client.joinRoom({
      roomCode: storedIdentity.roomCode,
      nickname: storedIdentity.nickname ?? '玩家',
    });
  };

  return (
    <div className="page">
      <header className="hero">
        <p className="hero__eyebrow">pnpm workspace · monorepo</p>
        <h1 className="hero__title">H5 Game Platform</h1>
        <p className="hero__subtitle">
          可复用的 H5 联机游戏平台。当前处于 <strong>阶段 2：通用房间系统与游戏生命周期</strong>
          ，房间创建、加入、准备、开始、暂停、继续、结束已可用；
          <strong>扩散大师的具体游戏规则与动画尚未实现</strong>。
        </p>
      </header>

      <main className="grid">
        <section className="card card--wide" data-testid="room-card">
          <h2 className="card__title">房间</h2>

          {snapshot.lastError ? (
            <p className="gui-error" data-testid="room-error">
              [{snapshot.lastError.code}] {snapshot.lastError.message}
            </p>
          ) : null}

          {snapshot.room ? (
            <RoomView
              room={snapshot.room}
              status={snapshot.status}
              reconnectAttempts={snapshot.reconnectAttempts}
              selfPlayerId={snapshot.identity?.playerId ?? null}
              onToggleReady={(ready) => {
                if (ready) {
                  client.setReady();
                } else {
                  client.setUnready();
                }
              }}
              onStart={() => client.startGame()}
              onPause={() => client.pauseGame()}
              onResume={() => client.resumeGame()}
              onEnd={() => client.endGame()}
              onLeave={() => client.leaveRoom()}
            />
          ) : (
            <>
              <RoomEntry
                gameId={diffusionMaster.id}
                disabled={busy || snapshot.status === 'connecting'}
                onCreate={handleCreate}
                onJoin={handleJoin}
              />
              {storedIdentity ? (
                <div className="gui-actions" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    data-testid="btn-resume-room"
                    className="gui-button"
                    onClick={handleResume}
                  >
                    恢复上次房间（{storedIdentity.roomCode}）
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">项目状态</h2>
          <dl className="kv">
            <div>
              <dt>阶段</dt>
              <dd>阶段 2 · 通用房间系统</dd>
            </div>
            <div>
              <dt>前端</dt>
              <dd>React + TypeScript + Vite</dd>
            </div>
            <div>
              <dt>实时房间</dt>
              <dd>Durable Object + WebSocket（已实现）</dd>
            </div>
            <div>
              <dt>持久化</dt>
              <dd>DO storage（实时）+ D1（生命周期记录）</dd>
            </div>
          </dl>
        </section>

        <section className="card">
          <h2 className="card__title">游戏入口</h2>
          <ul className="games">
            <li className="game">
              <div>
                <p className="game__name">{diffusionMaster.name}</p>
                <p className="game__meta">
                  {diffusionMaster.id} · {diffusionMaster.minPlayers}–
                  {diffusionMaster.maxPlayers} 人 · v{diffusionMaster.version}
                </p>
              </div>
              <span
                className={
                  diffusionMasterImplemented ? 'badge badge--ok' : 'badge badge--pending'
                }
              >
                {diffusionMasterImplemented ? '可玩' : '规则未实现'}
              </span>
            </li>
          </ul>
          <p className="card__note">房间系统已可用；游戏规则、动画与结算属于后续阶段。</p>
        </section>

        <section className="card">
          <h2 className="card__title">运行环境信息</h2>
          <dl className="kv">
            <div>
              <dt>模式</dt>
              <dd>{runtime.mode}</dd>
            </div>
            <div>
              <dt>Vite</dt>
              <dd>{runtime.viteVersion}</dd>
            </div>
            <div>
              <dt>React</dt>
              <dd>{reactVersion}</dd>
            </div>
            <div>
              <dt>协议版本</dt>
              <dd>{runtime.protocolVersion}</dd>
            </div>
            <div>
              <dt>构建时间</dt>
              <dd>{runtime.buildTime}</dd>
            </div>
            <div>
              <dt>User Agent</dt>
              <dd className="kv__wrap">{runtime.userAgent}</dd>
            </div>
          </dl>
        </section>

        <section className="card">
          <h2 className="card__title">Worker 健康检查</h2>
          {health.phase === 'loading' ? (
            <p className="card__note">检查中…</p>
          ) : health.result.ok ? (
            <dl className="kv">
              <div>
                <dt>status</dt>
                <dd>
                  <span className="badge badge--ok">{health.result.data.status}</span>
                </dd>
              </div>
              <div>
                <dt>service</dt>
                <dd>{health.result.data.service}</dd>
              </div>
              <div>
                <dt>environment</dt>
                <dd>{health.result.data.environment}</dd>
              </div>
              <div>
                <dt>protocolVersion</dt>
                <dd>{health.result.data.protocolVersion}</dd>
              </div>
              <div>
                <dt>timestamp</dt>
                <dd>{health.result.data.timestamp}</dd>
              </div>
            </dl>
          ) : (
            <p className="card__error">
              无法连接 Worker（{health.result.error}）。请先执行
              <code> pnpm dev:worker </code>启动本地 Worker。
            </p>
          )}
        </section>

        <section className="card card--wide">
          <h2 className="card__title">渲染管线验证</h2>
          <GameCanvas />
        </section>
      </main>

      <footer className="footer">
        <span>阶段 2 以功能验证为主，未做复杂视觉设计。</span>
      </footer>
    </div>
  );
}
