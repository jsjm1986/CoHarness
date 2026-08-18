import { Capacitor, registerPlugin, type Plugin } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

const DEVICE_ID_KEY = 'hgw.push.device-id'
const SESSION_SELECTION_KEY = 'dsh.sessions.current'
const CHANNEL_ID = 'ai-replies'

type PushProvider = 'fcm' | 'jpush'

interface NativeNotificationAction {
  sessionId?: string
  eventSeq?: string
}

interface NativePushStatusPlugin extends Plugin {
  isFcmConfigured(): Promise<{ configured: boolean }>
  isJPushConfigured(): Promise<{ configured: boolean }>
  initializeJPush(): Promise<{ configured: boolean }>
  getJPushRegistrationId(): Promise<{ registrationId: string }>
}

const NativePushStatus = registerPlugin<NativePushStatusPlugin>('NativePushStatus')

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function registerToken(token: string, provider: PushProvider): Promise<void> {
  const response = await fetch('/account/api/push-devices', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, platform: 'android', provider }),
  })
  if (!response.ok) throw new Error(`push device registration failed: HTTP ${String(response.status)}`)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('push device registration returned invalid data')
  }
  const id = stringValue((body as { id?: unknown }).id)
  if (id === undefined) throw new Error('push device registration returned no id')
  localStorage.setItem(`${DEVICE_ID_KEY}.${provider}`, id)
}

function openNotificationSession(data: unknown): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return
  const sessionId = stringValue((data as { sessionId?: unknown }).sessionId)
  if (sessionId === undefined) return
  localStorage.setItem(SESSION_SELECTION_KEY, JSON.stringify({ sessionId }))
  window.location.assign('/')
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds))
}

async function registerJPushDevice(configured: boolean): Promise<void> {
  if (!configured) return
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const result = await NativePushStatus.getJPushRegistrationId()
      const registrationId = stringValue(result.registrationId)
      if (registrationId !== undefined) {
        await registerToken(registrationId, 'jpush')
        return
      }
    } catch (error: unknown) {
      console.warn('[web] JPush registration lookup failed:', error)
      return
    }
    await wait(1000)
  }
}

/** Register configured Android push providers; browser sessions remain unchanged. */
export async function setupNativePush(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return
  const jpushAvailable = Capacitor.isPluginAvailable('NativePushStatus')
  const pushPluginAvailable = Capacitor.isPluginAvailable('PushNotifications')
  let fcmConfigured = true
  let jpushConfigured = jpushAvailable
  if (jpushAvailable) {
    try {
      fcmConfigured = (await NativePushStatus.isFcmConfigured()).configured
    } catch (error: unknown) {
      // Older shells do not expose the method; retain the previous FCM behavior.
      console.warn('[web] FCM configuration lookup failed:', error)
    }
    try {
      jpushConfigured = (await NativePushStatus.isJPushConfigured()).configured
    } catch (error: unknown) {
      console.warn('[web] JPush configuration lookup failed:', error)
      jpushConfigured = false
    }
  }
  if (!fcmConfigured && !jpushConfigured) return

  if (pushPluginAvailable) {
    try {
      const permission = await PushNotifications.checkPermissions()
      const received = permission.receive === 'granted'
        ? permission
        : await PushNotifications.requestPermissions()
      if (received.receive !== 'granted') return
    } catch (error: unknown) {
      console.warn('[web] push permission check failed:', error)
      if (!jpushConfigured) return
    }
  }

  if (jpushAvailable && jpushConfigured) {
    try {
      jpushConfigured = (await NativePushStatus.initializeJPush()).configured
    } catch (error: unknown) {
      console.warn('[web] JPush initialization failed:', error)
      jpushConfigured = false
    }
  }
  if (!fcmConfigured && !jpushConfigured) return

  if (fcmConfigured && pushPluginAvailable) {
    await PushNotifications.addListener('registration', ({ value }) => {
      void registerToken(value, 'fcm').catch((error: unknown) => {
        console.warn('[web] FCM device registration failed:', error)
      })
    })
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      openNotificationSession(action.notification.data)
    })
  }
  if (jpushAvailable && jpushConfigured) {
    await NativePushStatus.addListener('notificationAction', (action: NativeNotificationAction) => {
      openNotificationSession(action)
    })
  }
  if (pushPluginAvailable) {
    try {
      await PushNotifications.createChannel({
        id: CHANNEL_ID,
        name: 'AI 回复',
        description: 'AI 回复完成提醒',
        importance: 5,
        sound: 'default',
        vibration: true,
      })
    } catch (error: unknown) {
      console.warn('[web] push notification channel setup failed:', error)
    }
  }
  if (fcmConfigured && pushPluginAvailable) {
    try {
      await PushNotifications.register()
    } catch (error: unknown) {
      console.warn('[web] FCM registration failed:', error)
    }
  }
  if (jpushAvailable && jpushConfigured) void registerJPushDevice(jpushConfigured)
}
