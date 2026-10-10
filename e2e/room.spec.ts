import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** 以房主身份创建房间，返回房间码。 */
async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('input-nickname').fill(nickname);
  await page.getByTestId('btn-create-room').click();

  const code = page.getByTestId('room-code');
  await expect(code).toBeVisible();
  return ((await code.textContent()) ?? '').trim();
}

/** 以普通玩家身份加入房间。 */
async function joinRoom(page: Page, nickname: string, roomCode: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('input-nickname').fill(nickname);
  await page.getByTestId('input-room-code').fill(roomCode);
  await page.getByTestId('btn-join-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(roomCode);
}

test.describe('双浏览器联机房间', () => {
  test('创建 → 加入 → 准备 → 开始 → 暂停 → 继续 → 结束', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // 玩家 A 创建房间
      const roomCode = await createRoom(pageA, '玩家A');
      expect(roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      await expect(pageA.getByTestId('room-phase')).toHaveText('等待玩家');

      // 玩家 B 加入
      await joinRoom(pageB, '玩家B', roomCode);

      // 双方看到相同的玩家列表
      await expect(pageA.getByTestId('player-list').locator('li')).toHaveCount(2);
      await expect(pageB.getByTestId('player-list').locator('li')).toHaveCount(2);
      await expect(pageA.getByTestId('player-list')).toContainText('玩家B');
      await expect(pageB.getByTestId('player-list')).toContainText('玩家A');
      await expect(pageA.getByTestId('player-list')).toContainText('房主');

      // 非房主不能开始
      await expect(pageB.getByTestId('btn-start')).toBeDisabled();

      // B 准备后 A 能看到变化
      await pageB.getByTestId('btn-ready').click();
      await expect(pageB.getByTestId('btn-ready')).toHaveText('取消准备');
      await expect(pageA.getByTestId('player-list')).toContainText('已准备');
      await expect(pageB.getByTestId('player-list')).toContainText('已准备');
      await expect(pageA.getByTestId('room-phase')).toHaveText('准备就绪');
      await expect(pageB.getByTestId('room-phase')).toHaveText('准备就绪');

      // A 开始游戏，双方都进入 PLAYING
      await pageA.getByTestId('btn-start').click();
      await expect(pageA.getByTestId('room-phase')).toHaveText('游戏进行中');
      await expect(pageB.getByTestId('room-phase')).toHaveText('游戏进行中');

      // A 暂停，双方一致
      await pageA.getByTestId('btn-pause').click();
      await expect(pageA.getByTestId('room-phase')).toHaveText('已暂停');
      await expect(pageB.getByTestId('room-phase')).toHaveText('已暂停');
      await expect(pageB.getByTestId('btn-pause')).toBeDisabled();

      // A 继续，双方一致
      await pageA.getByTestId('btn-resume').click();
      await expect(pageA.getByTestId('room-phase')).toHaveText('游戏进行中');
      await expect(pageB.getByTestId('room-phase')).toHaveText('游戏进行中');

      // A 结束，双方一致
      await pageA.getByTestId('btn-end').click();
      await expect(pageA.getByTestId('room-phase')).toHaveText('已结束');
      await expect(pageB.getByTestId('room-phase')).toHaveText('已结束');
      await expect(pageA.getByTestId('btn-end')).toBeDisabled();
      await expect(pageB.getByTestId('btn-end')).toBeDisabled();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('刷新后通过身份令牌恢复座位', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      const roomCode = await createRoom(pageA, '玩家A');
      await joinRoom(pageB, '玩家B', roomCode);
      await expect(pageA.getByTestId('player-list').locator('li')).toHaveCount(2);

      // B 刷新页面（WebSocket 断开），通过持久化身份重新加入
      await pageB.reload();
      await expect(pageB.getByTestId('btn-resume-room')).toBeVisible();
      await pageB.getByTestId('btn-resume-room').click();

      await expect(pageB.getByTestId('room-code')).toHaveText(roomCode);
      await expect(pageB.getByTestId('player-list').locator('li')).toHaveCount(2);
      await expect(pageB.getByTestId('player-list')).toContainText('玩家B');
      await expect(pageA.getByTestId('player-list').locator('li')).toHaveCount(2);
      await expect(pageA.getByTestId('player-list')).toContainText('玩家B');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
