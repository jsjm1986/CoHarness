/**
 * Stream URL built by `ClientRemoteDesktops.attach`: the one-time token plus
 * the document-identity pinning (`dshTarget`/`dshPrincipal`) the Gateway
 * upgrade needs to proxy the WebSocket to the runtime that minted the token —
 * the scope cookie alone is unreliable for this.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientRemoteDesktops } from '../src/client/index.ts'
import type { RemoteDesktopRemote } from '../src/client/index.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})
const signal = (): AbortSignal => new AbortController().signal

function remote(): RemoteDesktopRemote {
  return {
    attach: async () => ({
      ok: true,
      value: {
        id: 'sess-1',
        spec: { target: { nodeId: 'node-1' }, level: 'view', recording: false },
        stream: { path: '/api/remote-desktop/stream', token: 'tok-1' },
      },
    }),
  } as unknown as RemoteDesktopRemote
}

function fixture(privateResourceUrl?: (value: string) => string): ClientRemoteDesktops {
  const ctx = new Context()
  roots.push(ctx)
  return new ClientRemoteDesktops(ctx, remote(), privateResourceUrl)
}

describe('ClientRemoteDesktops.attach stream URL', () => {
  it('pins the runtime target and principal on the stream URL', async () => {
    vi.stubGlobal('location', { href: 'https://app.example/' })
    // Stand-in for the identity fence: appends the runtime and principal
    // params exactly as `BrowserIdentityFence.privateUrl` does.
    const privateResourceUrl = (value: string): string => `${value}&dshTarget=project%3A3&dshPrincipal=1`
    const attachment = await fixture(privateResourceUrl).attach('session' as SessionId, { nodeId: 'node-1' }, 'view', signal())
    const url = new URL(attachment.url)
    expect(url.protocol).toBe('wss:')
    expect(url.searchParams.get('token')).toBe('tok-1')
    expect(url.searchParams.get('dshTarget')).toBe('project:3')
    expect(url.searchParams.get('dshPrincipal')).toBe('1')
  })

  it('still returns a usable stream URL when no identity pinning is available', async () => {
    vi.stubGlobal('location', { href: 'https://app.example/' })
    const attachment = await fixture().attach('session' as SessionId, { nodeId: 'node-1' }, 'view', signal())
    const url = new URL(attachment.url)
    expect(url.protocol).toBe('wss:')
    expect(url.pathname).toBe('/api/remote-desktop/stream')
    expect(url.searchParams.get('token')).toBe('tok-1')
  })
})
