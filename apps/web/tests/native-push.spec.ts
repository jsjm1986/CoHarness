import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupNativePush } from '../src/native-push.ts'

const bridge = vi.hoisted(() => ({
  native: true,
  requestedName: '',
  listeners: new Map<string, (data: unknown) => void>(),
  fcm: false,
  jpush: true,
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => bridge.native,
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
  },
  registerPlugin: (name: string) => { bridge.requestedName = name; return {
    isFcmConfigured: async () => ({ configured: bridge.fcm }),
    isJPushConfigured: async () => ({ configured: bridge.jpush }),
    initializeJPush: async () => ({ configured: true }),
    getJPushRegistrationId: async () => ({ registrationId: 'private-test-token' }),
    addListener: async (event: string, callback: (data: unknown) => void) => { bridge.listeners.set(event, callback) },
  } },
}))
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: 'granted' }),
    createChannel: async () => {},
    register: async () => {},
    addListener: async (event: string, callback: (data: unknown) => void) => { bridge.listeners.set(event, callback) },
  },
}))

describe('Android Web notification protocol', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server !== undefined) {
      const owned = server
      owned.closeAllConnections()
      await new Promise<void>((resolve, reject) => owned.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      server = undefined
    }
    vi.unstubAllGlobals()
    bridge.listeners.clear()
    bridge.native = true
    bridge.fcm = false
    bridge.jpush = true
  })

  it('registers the Android provider on a private endpoint and navigates notification sessions', async () => {
    const requests: { url: string | undefined; method: string | undefined; body: unknown }[] = []
    server = createServer((request, response) => {
      request.setEncoding('utf8')
      let body = ''
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        requests.push({ url: request.url, method: request.method, body: JSON.parse(body) as unknown })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'test-device' }))
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test endpoint has no TCP address')
    const endpoint = `http://127.0.0.1:${String(address.port)}`
    const originalFetch = globalThis.fetch
    const fetcher = vi.fn((url: string, options: RequestInit) => originalFetch(new URL(url, endpoint), options))
    const storage = new Map<string, string>()
    const assign = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => storage.set(key, value) })
    vi.stubGlobal('window', { location: { assign } })
    await setupNativePush()
    expect(bridge.requestedName).toBe('NativePushStatus')
    await vi.waitFor(() =>{  expect(storage.get('hgw.push.device-id.jpush')).toBe('test-device') })
    expect(requests).toEqual([{ url: '/account/api/push-devices', method: 'POST', body: {
      token: 'private-test-token', platform: 'android', provider: 'jpush',
    } }])
    expect(fetcher.mock.calls[0]?.[1].credentials).toBe('include')
    const action = bridge.listeners.get('notificationAction')
    expect(action).toBeTypeOf('function')
    action!({ sessionId: 'session-17', eventSeq: '42' })
    expect(storage.get('dsh.sessions.current')).toBe(JSON.stringify({ sessionId: 'session-17' }))
    expect(assign).toHaveBeenCalledExactlyOnceWith('/')
    action!({ eventSeq: '42' })
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('keeps hosted Web sessions outside native registration', async () => {
    bridge.native = false
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await setupNativePush()
    expect(fetcher).not.toHaveBeenCalled()
    expect(bridge.listeners.size).toBe(0)
  })
})
