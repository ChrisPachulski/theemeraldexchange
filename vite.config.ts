import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const NAS_HOST = 'theemeraldexchange.local'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api/sonarr': {
          target: `http://${NAS_HOST}:8989`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/sonarr/, '/tv'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.SONARR_API_KEY) proxyReq.setHeader('X-Api-Key', env.SONARR_API_KEY)
            })
          },
        },
        '/api/radarr': {
          target: `http://${NAS_HOST}:7878`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/radarr/, '/movies'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.RADARR_API_KEY) proxyReq.setHeader('X-Api-Key', env.RADARR_API_KEY)
            })
          },
        },
        '/api/sab': {
          target: `http://${NAS_HOST}:8080`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/sab/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (!env.SAB_API_KEY) return
              const url = new URL(proxyReq.path, 'http://placeholder')
              if (!url.searchParams.has('apikey')) {
                url.searchParams.set('apikey', env.SAB_API_KEY)
                proxyReq.path = url.pathname + url.search
              }
            })
          },
        },
      },
    },
  }
})
