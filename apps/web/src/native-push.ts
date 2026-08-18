import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

const DEVICE_ID_KEY = 'hgw.push.device-id'
const SESSION_SELECTION_KEY = 'dsh.sessions.current'
const CHANNEL_ID = 'ai-replies'

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function registerToken(token: string): Promise<void> {
  const response = await fetch('/account/api/push-devices', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, platform: 'android' }),
  })
  if (!response.ok) throw new Error(`push device registration failed: HTTP ${String(response.status)}`)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('push device registration returned invalid data')
  }
  const id = stringValue((body as { id?: unknown }).id)
  if (id === undefined) throw new Error('push device registration returned no id')
  localStorage.setItem(DEVICE_ID_KEY, id)
}

function openNotificationSession(data: unknown): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return
  const sessionId = stringValue((data as { sessionId?: unknown }).sessionId)
  if (sessionId === undefined) return
  localStorage.setItem(SESSION_SELECTION_KEY, JSON.stringify({ sessionId }))
  window.location.assign('/')
}

/** Register FCM on the Android shell; browser sessions remain unchanged. */
export async function setupNativePush(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return

  const permission = await PushNotifications.checkPermissions()
  const received = permission.receive === 'granted'
    ? permission
    : await PushNotifications.requestPermissions()
  if (received.receive !== 'granted') return

  await PushNotifications.addListener('registration', ({ value }) => {
    void registerToken(value).catch((error: unknown) => {
      console.warn('[web] push device registration failed:', error)
    })
  })
  await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    openNotificationSession(action.notification.data)
  })
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
  await PushNotifications.register()
}
