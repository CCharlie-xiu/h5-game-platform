import {
  implemented as diffusionMasterImplemented,
  manifest as diffusionMaster,
} from '@h5/diffusion-master';
import { useEffect, useState } from 'react';
import { version as reactVersion } from 'react';

import { GameCanvas } from './components/GameCanvas';
import { fetchHealth } from './lib/api';
import type { HealthResult } from './lib/api';
import { getRuntimeInfo } from './lib/runtime';

type HealthState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'settled'; readonly result: HealthResult };

/** 阶段 1 首页：展示项目状态、游戏入口、运行环境与 Worker 健康检查。 */
export function App() {
  const runtime = getRuntimeInfo();
  const [health, setHealth] = useState<HealthState>({ phase: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal).then((result) => {
      setHealth({ phase: 'settled', result });
    });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <div className="page">
      <header className="hero">
        <p className="hero__eyebrow">pnpm workspace · monorepo</p>
        <h1 className="hero__title">H5 Game Platform</h1>
        <p className="hero__subtitle">
          可复用的 H5 联机游戏平台。当前处于 <strong>阶段 1：工程初始化</strong>
          ，只完成工程骨架与运行验证；游戏规则、动画与房间系统尚未实现。
        </p>
      </header>

      <main className="grid">
        <section className="card">
          <h2 className="card__title">项目状态</h2>
          <dl className="kv">
            <div>
              <dt>阶段</dt>
              <dd>阶段 1 · 工程初始化</dd>
            </div>
            <div>
              <dt>前端</dt>
              <dd>React + TypeScript + Vite</dd>
            </div>
            <div>
              <dt>渲染</dt>
              <dd>Phaser（已接入，仅占位舞台）</dd>
            </div>
            <div>
              <dt>后端</dt>
              <dd>Cloudflare Workers（本地开发）</dd>
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
                {diffusionMasterImplemented ? '可玩' : '尚未实现'}
              </span>
            </li>
          </ul>
          <p className="card__note">游戏规则、房间匹配与玩家同步属于后续阶段。</p>
        </section>

        <section className="card">
          <h2 className="card__title">运行环境信息</h2>
          <dl className="kv">
            <div>
              <dt>模式</dt>
              <dd>{runtime.mode}</dd>
            </div>
            <div>
              <dt>DEV / PROD</dt>
              <dd>
                {String(runtime.dev)} / {String(runtime.prod)}
              </dd>
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
        <span>阶段 1 仅用于工程验证，不代表最终功能形态。</span>
      </footer>
    </div>
  );
}
