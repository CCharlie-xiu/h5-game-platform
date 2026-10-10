import Phaser from 'phaser';
import { useEffect, useRef, useState } from 'react';

/**
 * 占位场景。
 *
 * 仅用于验证 Phaser 渲染管线可用，**不包含任何游戏逻辑**。
 */
class StageScene extends Phaser.Scene {
  constructor() {
    super('stage');
  }

  create(): void {
    this.add
      .text(240, 80, 'Phaser renderer ready', {
        color: '#7dd3fc',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '16px',
      })
      .setOrigin(0.5);
  }
}

/** 阶段 1 的渲染管线验证组件：启动一个空白 Phaser 舞台。 */
export function GameCanvas() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phaserVersion, setPhaserVersion] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    setPhaserVersion(Phaser.VERSION);

    let game: Phaser.Game | undefined;
    try {
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host,
        width: 480,
        height: 160,
        backgroundColor: '#0b1220',
        scene: [StageScene],
      });
    } catch (error) {
      console.error('[GameCanvas] Phaser 初始化失败', error);
    }

    return () => {
      game?.destroy(true);
    };
  }, []);

  return (
    <div className="stage">
      <div className="stage__host" ref={hostRef} />
      <p className="stage__meta">
        Phaser {phaserVersion || '…'} · 仅验证渲染管线，尚未接入任何游戏
      </p>
    </div>
  );
}
