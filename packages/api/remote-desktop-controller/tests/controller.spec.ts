/**
 * Wire-error translation for management and listing methods: capability
 * rejections must reach clients with their stable code in `details.code`, the
 * field RemoteDesktopBody branches on.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteDesktopController } from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const signal = (): AbortSignal => new AbortController().signal

function agent(ctx: Context): Agent {
  return { id: 'session' as SessionId, ctx } as unknown as Agent
}

/**
 * Controller over a capability that rejects every call with the given error.
 * Standalone mode (no `executionAuthorityRequired`) resolves the local
 * administrator actor, so method calls reach the mocked capability directly.
 */
function fixture(capability: Record<string, () => Promise<never>>) {
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('remoteDesktop', capability as never)
  return { ctx, controller: new RemoteDesktopController(ctx) }
}

async function wireCode(call: Promise<unknown>): Promise<string | undefined> {
  const failure = await call.then(
    () => { throw new Error('call unexpectedly succeeded') },
    (error: unknown) => remoteErrorOf(error),
  )
  expect(failure?.code).toBe('remote-desktop/failure')
  return (failure?.details as { code?: string }).code
}

describe('RemoteDesktopController error translation', () => {
  const capabilityError = new RemoteDesktopError('grant row is gone', 'REMOTE_DESKTOP_GRANT_NOT_FOUND')

  it('translates listGrants capability rejections into the wire failure code', async () => {
    const h = fixture({ listGrants: async () => { throw capabilityError } })
    expect(await wireCode(h.controller.listGrants(agent(h.ctx), {}, signal()))).toBe('REMOTE_DESKTOP_GRANT_NOT_FOUND')
  })

  it('translates grant capability rejections into the wire failure code', async () => {
    const h = fixture({ grant: async () => { throw capabilityError } })
    const request = {
      target: { nodeId: 'n1' }, principal: 'alice', level: 'view' as const,
      scope: { kind: 'machine' as const }, recording: false,
    }
    expect(await wireCode(h.controller.grant(agent(h.ctx), request, signal()))).toBe('REMOTE_DESKTOP_GRANT_NOT_FOUND')
  })

  it('translates setLevel capability rejections into the wire failure code', async () => {
    const h = fixture({ setLevel: async () => { throw capabilityError } })
    expect(await wireCode(h.controller.setLevel(agent(h.ctx), { grantId: 'g1', level: 'control' }, signal()))).toBe('REMOTE_DESKTOP_GRANT_NOT_FOUND')
  })

  it('translates revoke capability rejections into the wire failure code', async () => {
    const h = fixture({ revoke: async () => { throw capabilityError } })
    expect(await wireCode(h.controller.revoke(agent(h.ctx), { grantId: 'g1' }, signal()))).toBe('REMOTE_DESKTOP_GRANT_NOT_FOUND')
  })
})
