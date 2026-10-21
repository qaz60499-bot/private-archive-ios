import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'cd.cc.joye.photo',
  appName: 'Private Adventure',
  webDir: 'dist',
  server: {
    hostname: 'localhost',
    iosScheme: 'capacitor',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    CapacitorCookies: {
      enabled: true,
    },
  },
}

export default config
