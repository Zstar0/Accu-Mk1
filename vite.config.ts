import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path, { resolve } from 'path'
import packageJson from './package.json'

const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    react({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 600, // Prevent warnings for template's bundled components
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'quick-pane': resolve(__dirname, 'quick-pane.html'),
      },
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Same-origin API proxy — mirrors the baked nginx image (nginx.conf:
    // `location /api/` strips the prefix and proxies to the backend). When a
    // mounted dev stack sets VITE_API_URL=/api, the SPA calls a relative base
    // and this dev server forwards /api/* to the backend container, stripping
    // /api exactly like nginx. That makes a stack reached over Tailscale work
    // with no absolute "localhost" base, no backend CORS, and no exposed
    // backend port. Dormant for local desktop dev (absolute VITE_API_URL never
    // hits /api). changeOrigin stays off to preserve the Host header like nginx.
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8012',
        changeOrigin: false,
        rewrite: p => p.replace(/^\/api/, ''),
      },
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      // Also exclude node_modules + .planning/ (large trees that never change
      // during dev) to keep polling cost proportional to actual source size.
      ignored: [
        '**/src-tauri/**',
        '**/node_modules/**',
        '**/.planning/**',
      ],
      // 4. Docker Desktop on Windows doesn't reliably forward filesystem events
      //    through bind mounts. Polling fixes HMR. Interval 1000ms keeps idle
      //    CPU low; HMR feels ~0.5-1s slower than 300ms but still usable.
      usePolling: true,
      interval: 1000,
    },
  },
}))
