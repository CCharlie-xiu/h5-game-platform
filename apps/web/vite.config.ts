import react from '@vitejs/plugin-react';
import { defineConfig, version as viteVersion } from 'vite';

/**
 * 前端构建配置。
 *
 * 开发期 `/api` 代理到本地 Worker（wrangler dev，默认 8787），
 * 使前端可以用同源路径调用 Worker，避免开发期跨域配置。
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __VITE_VERSION__: JSON.stringify(viteVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // 房间 WebSocket 走同源路径 /api/rooms/:code/ws，必须开启 ws 转发
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Phaser 单包体积较大，放宽告警阈值避免噪音
    chunkSizeWarningLimit: 1600,
  },
});
