import type { CapacitorConfig } from '@capacitor/cli'

const webUrl = process.env.DSH_ANDROID_WEB_URL?.trim() || 'https://harness.maycran.com/'
const parsed = new URL(webUrl)

const config: CapacitorConfig = {
  appId: process.env.DSH_ANDROID_APP_ID?.trim() || 'com.deepseek.harness',
  appName: 'CoHarness',
  webDir: 'dist',
  server: {
    url: webUrl,
    cleartext: parsed.protocol === 'http:',
    allowNavigation: [parsed.host],
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
}

export default config
