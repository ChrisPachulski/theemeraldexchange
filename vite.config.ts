import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const backendTarget = `http://localhost:${env.PORT || '3001'}`
  const analyze = env.ANALYZE === '1' || env.ANALYZE === 'true'

  // Every /api/* path goes through the Hono backend now. The backend
  // allow-lists each Sonarr/Radarr/SAB endpoint with role + disk-space
  // checks; the SPA's API clients keep their existing /api/sonarr,
  // /api/radarr, /api/sab paths so nothing in the SPA needs to change.
  // In prod (Netlify) the SPA points at api.<domain> directly and this
  // proxy block is irrelevant.
  return {
    plugins: [
      react(),
      ...(analyze
        ? [
            visualizer({
              filename: 'dist/stats.html',
              gzipSize: true,
              brotliSize: true,
            }),
          ]
        : []),
    ],
    server: {
      proxy: {
        '/api': { target: backendTarget, changeOrigin: false },
      },
    },
  }
})
