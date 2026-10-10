import { RoomClient, createLocalStorageIdentityStore } from '@h5/game-client';
import { useSyncExternalStore } from 'react';

/** 身份持久化（localStorage）。 */
export const identityStore = createLocalStorageIdentityStore();

/** 全局房间客户端（单页面应用内共享一个连接）。 */
export const roomClient = new RoomClient({
  storage: identityStore,
});

/** 订阅房间客户端状态。 */
export function useRoomClient() {
  const snapshot = useSyncExternalStore(
    (listener) => roomClient.subscribe(listener),
    () => roomClient.getSnapshot(),
    () => roomClient.getSnapshot(),
  );

  return { client: roomClient, snapshot };
}
