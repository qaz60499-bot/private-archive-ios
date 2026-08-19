import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['archive-mark.svg', 'icons/archive-192.svg', 'icons/archive-512.svg'],
      manifest: {
        name: 'Private Archive',
        short_name: 'Archive',
        description: 'A quiet private media archive backed by Telegram.',
        theme_color: '#f1efe9',
        background_color: '#f1efe9',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/archive-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/archive-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//, /^\/access-check$/],
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        globIgnores: ['**/three.module-*.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/assets/') && url.pathname.endsWith('/media'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/assets/') && url.pathname.endsWith('/preview'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'archive-previews-v2',
              expiration: { maxEntries: 600, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'archive-ui-images', expiration: { maxEntries: 120, maxAgeSeconds: 604800 } },
          },
        ],
      },
      devOptions: { enabled: true },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { sourcemap: true, target: 'es2022' },
})
