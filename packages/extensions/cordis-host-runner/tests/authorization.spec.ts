import { describe, expect, it } from 'vitest'
import { CollaborationError } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAction, CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AGENT_A, AGENT_B, CLIENT_CODE, mount, setup } from './helpers.ts'
import type { ApprovalRequestId } from '../src/types.ts'

/**
 * Registry-resolved collaboration authorization: the Remotes whose wire
 * arguments carry no Session identity (resolveRequestRun, invoke) and the
 * readable-Session filtering of the process-wide inventory.
 */

const HOST_ONLY_CODE = 'return { name: "host-only", apply() {} }'

function projectAuthority(overrides?: {
  scope?: CollaborationAuthority['participant']['scope']
  authorize?: (sessionId: SessionId, action: CollaborationAction) => Promise<unknown>
  readableSessionIds?: (sessionIds: readonly SessionId[]) => Promise<ReadonlySet<SessionId>>
}): CollaborationAuthority {
  return {
    participant: {
      userId: 7,
      username: 'alice',
      displayName: 'Alice',
      role: 'user',
      scope: overrides?.scope ?? { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
    },
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
    authorize: (overrides?.authorize ?? (async sessionId => ({
      sessionId,
      rootSessionId: sessionId,
      mode: 'rw',
      canRead: true as const,
      canWrite: true,
      canManage: true,
      projectId: 41,
      visibility: 'project' as const,
      creatorUserId: 7,
    }))) as CollaborationAuthority['authorize'],
    readableSessionIds: overrides?.readableSessionIds ?? (async sessionIds => new Set(sessionIds)),
    claimInteraction: () => Promise.resolve(true),
  }
}

function refusingAuthority(mode: 'ro'): CollaborationAuthority {
  return projectAuthority({
    scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode },
    authorize: () => Promise.reject(new CollaborationError('forbidden')),
  })
}

async function setupWithCollaboration(authority: CollaborationAuthority) {
  const harness = await setup()
  harness.ctx.provide('collaboration', {
    capture: () => authority,
    currentCreation: () => undefined,
    withSessionCreation: (_creation: unknown, operation: () => Promise<unknown>) => operation(),
  } as never)
  return harness
}

async function defineClientPlugin(harness: Awaited<ReturnType<typeof setup>>, agent: Agent): Promise<string> {
  const { pluginId, packageId } = harness.runner.define({
    sessionId: agent.id,
    plugin: { kind: 'new', idPrefix: 'note' },
    name: 'notepad',
    purpose: 'spec fixture',
    code: { host: HOST_ONLY_CODE, client: CLIENT_CODE },
  })
  const receipt = await harness.runner.run(agent, pluginId, packageId, 'run')
  if (!receipt.ok) throw new Error(receipt.message)
  return pluginId
}

async function pendingRequestId(harness: Awaited<ReturnType<typeof setup>>, pluginId: string): Promise<ApprovalRequestId> {
  const rows = await harness.runner.inventory()
  const attempt = rows.find(row => String(row.pluginId) === pluginId)?.latestRun
  const requestId = attempt?.approvalRequestId
  if (requestId === undefined) throw new Error('expected an awaiting-approval run request')
  return requestId
}

async function activeRunId(harness: Awaited<ReturnType<typeof setup>>, pluginId: string) {
  const rows = await harness.runner.inventory()
  const runId = rows.find(row => String(row.pluginId) === pluginId)?.activeRun?.pluginRunId
  if (runId === undefined) throw new Error('expected a running host half')
  return runId
}

describe('registry-resolved collaboration authorization', () => {
  it('resolveRequestRun authorizes approve against the request Session and settles when granted', async () => {
    const authority = projectAuthority()
    const granted: Array<[SessionId, string]> = []
    const base = authority.authorize
    authority.authorize = async (sessionId, action) => {
      granted.push([sessionId, action])
      return base(sessionId, action) as never
    }
    const harness = await setupWithCollaboration(authority)
    const pluginId = await defineClientPlugin(harness, AGENT_A)
    const requestId = await pendingRequestId(harness, pluginId)

    const ack = await harness.runner.resolveRequestRun(requestId, { ok: false, reason: 'rejected' })

    expect(ack).toEqual({ accepted: true })
    expect(granted).toEqual([[AGENT_A.id, 'approve']])
  })

  it('resolveRequestRun refuses a denied participant with the collaboration error branch', async () => {
    const harness = await setupWithCollaboration(refusingAuthority('ro'))
    const pluginId = await defineClientPlugin(harness, AGENT_A)
    const requestId = await pendingRequestId(harness, pluginId)

    const settled = harness.runner.resolveRequestRun(requestId, { ok: false, reason: 'rejected' })
    await expect(settled).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(settled).rejects.toMatchObject({
      failure: {
        code: 'collaboration-forbidden',
        details: { action: 'approve', reason: 'forbidden', sessionId: AGENT_A.id },
      },
    })
  })

  it('invoke authorizes write against the owning Session before running the handler', async () => {
    const authority = projectAuthority()
    const granted: Array<[SessionId, string]> = []
    const base = authority.authorize
    authority.authorize = async (sessionId, action) => {
      granted.push([sessionId, action])
      return base(sessionId, action) as never
    }
    const harness = await setupWithCollaboration(authority)
    const pluginId = await mount(harness, HOST_ONLY_CODE)
    const runId = await activeRunId(harness, pluginId)

    const result = await harness.runner.invoke(pluginId, runId, 'no-such-method', {})

    expect(result).toMatchObject({ ok: false, code: 'method-not-found' })
    expect(granted).toEqual([[AGENT_A.id, 'write']])
  })

  it('invoke refuses a denied participant with the collaboration error branch', async () => {
    const harness = await setupWithCollaboration(refusingAuthority('ro'))
    const pluginId = await mount(harness, HOST_ONLY_CODE)
    const runId = await activeRunId(harness, pluginId)

    const invoked = harness.runner.invoke(pluginId, runId, 'no-such-method', {})
    await expect(invoked).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(invoked).rejects.toMatchObject({
      failure: {
        code: 'collaboration-forbidden',
        details: { action: 'write', reason: 'forbidden', sessionId: AGENT_A.id },
      },
    })
  })

  it('inventory keeps every row without collaboration and filters to readable Sessions in project scope', async () => {
    const bare = await setup()
    const own = await defineClientPlugin(bare, AGENT_A)
    expect((await bare.runner.inventory()).map(row => String(row.pluginId))).toEqual([String(own)])

    const readable = new Set<SessionId>([AGENT_A.id])
    const harness = await setupWithCollaboration(projectAuthority({
      readableSessionIds: async sessionIds => new Set(sessionIds.filter(id => readable.has(id))),
    }))
    const visible = await defineClientPlugin(harness, AGENT_A)
    const hidden = harness.runner.define({
      sessionId: AGENT_B.id,
      plugin: { kind: 'new', idPrefix: 'other' },
      name: 'other-session-plugin',
      purpose: 'spec fixture',
      code: { host: HOST_ONLY_CODE },
    })

    const rows = await harness.runner.inventory()
    expect(rows.map(row => String(row.pluginId))).toEqual([String(visible)])
    expect(rows.some(row => String(row.pluginId) === String(hidden.pluginId))).toBe(false)
  })

  it('inventory keeps every row for a personal principal', async () => {
    const harness = await setupWithCollaboration(projectAuthority({ scope: { kind: 'personal' } }))
    const visible = await defineClientPlugin(harness, AGENT_A)
    harness.runner.define({
      sessionId: AGENT_B.id,
      plugin: { kind: 'new', idPrefix: 'other' },
      name: 'other-session-plugin',
      purpose: 'spec fixture',
      code: { host: HOST_ONLY_CODE },
    })

    const rows = await harness.runner.inventory()
    expect(rows).toHaveLength(2)
    expect(rows.some(row => String(row.pluginId) === String(visible))).toBe(true)
  })
})
