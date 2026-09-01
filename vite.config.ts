import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => ({
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
        // Remove obsolete precache generations after a portal deployment so a browser
        // previously controlled by the full SaaS shell cannot keep serving that shell.
        cleanupOutdatedCaches: true,
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
            // Private previews are authorization-gated API resources. Never satisfy
            // them from an account-blind Service Worker cache: a cached 200 could
            // otherwise outlive an app logout or a later permission downgrade.
            // The Worker may still use its own edge cache *after* authorization.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/assets/') && url.pathname.endsWith('/preview'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'archive-ui-images-v2', expiration: { maxEntries: 120, maxAgeSeconds: 604800 } },
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
  // Hosted Web is a public static asset surface behind Access. Keep source maps
  // only in the local desktop bundle so production Web deploys do not expose
  // source files, internal route names, or implementation comments.
  build: { sourcemap: mode !== 'web' && mode !== 'ios', target: 'es2022' },
}))
