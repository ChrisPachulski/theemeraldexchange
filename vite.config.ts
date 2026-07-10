import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const backendTarget = `http://localhost:${env.PORT || '3001'}`

  // Every /api/* path goes through the Hono backend now. The backend
  // allow-lists each Sonarr/Radarr/SAB endpoint with role + disk-space
  // checks; the SPA's API clients keep their existing /api/sonarr,
  // /api/radarr, /api/sab paths so nothing in the SPA needs to change.
  // In prod (Netlify) the SPA points at api.<domain> directly and this
  // proxy block is irrelevant.
  return {
    plugins: [react()],
    build: {
      // hls.js and the Three.js gem scene are intentionally isolated lazy
      // chunks (~509/516kB minified); neither is part of the entry path. Keep
      // the warning ceiling just above them so genuine growth still surfaces.
      chunkSizeWarningLimit: 520,
    },
    server: {
      proxy: {
        '/api': { target: backendTarget, changeOrigin: false },
      },
    },
  }
})
