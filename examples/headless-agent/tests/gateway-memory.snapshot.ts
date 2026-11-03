/** Signed HTTP requests preserve project memory authority across provider replacement. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryService, { type Config as MemoryConfig } from '@deepseek-ai/dsh-memory'
import GatewayCollaboration from '@deepseek-ai/dsh-collaboration-gateway'
import { GATEWAY_PRINCIPAL_HEADER } from '@deepseek-ai/dsh-gateway-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { loadGatewayComposition } from '../../../packages/context/gateway-runtime/tests/fixtures/gateway-admission.fixture.ts'

const expected = fileURLToPath(new URL('./snapshots/gateway-memory/provider-replacement.expected.json', import.meta.url))

it('keeps read-only signed requests denied through collaboration withdrawal and replacement', async () => {
  const application = await loadGatewayComposition({ projectId: 41 })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gateway-memory-snapshot-'))
  const ctx = application.ctx
  const scope = { kind: 'project' as const }
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(MemoryService, { space: 'project' } as MemoryConfig)
    const first = ctx.plugin(GatewayCollaboration)
    await first.await()
    ctx.effect(() => ctx.connection.http.handlePrefix('/api/memory-authority', async (_request, response) => {
      try {
        const result = await ctx.memory.memberSave({
          scope, key: 'shared', kind: 'guidance', summary: 'shared rule', content: 'shared body',
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.ok
          ? { operation: result.operation, writerUserId: result.entry.updated.userId }
          : { code: result.code }))
      } catch (error: unknown) {
        if (!(error instanceof RemoteError)) throw error
        const details = error.details as { reason: string }
        const code: unknown = error.code
        response.writeHead(details.reason === 'gateway-unavailable' ? 503 : 403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code, reason: details.reason }))
      }
    }, { authority: 'trusted-host' }))
    const issue = (mode: 'ro' | 'rw'): string => application.issue({
      scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode },
    })
    const request = async (phase: string, mode: 'ro' | 'rw') => {
      const response = await fetch(`${application.origin}/api/memory-authority`, {
        method: 'POST', headers: { [GATEWAY_PRINCIPAL_HEADER]: issue(mode) },
      })
      const body: unknown = await response.json()
      return { phase, status: response.status, body }
    }
    const results = [await request('read-only', 'ro')]
    await first.dispose()
    results.push(await request('provider-withdrawn', 'ro'))
    expect(await ctx.memory.entries(scope)).toEqual([])
    const replacement = ctx.plugin(GatewayCollaboration)
    await replacement.await()
    results.push(await request('replaced-read-only', 'ro'))
    results.push(await request('replaced-read-write', 'rw'))
    expect(JSON.stringify(results, null, 2) + '\n').toBe(await readFile(expected, 'utf8'))
    const durable: unknown = JSON.parse(await readFile(join(storageRoot, 'memory', 'entries', 'project_shared.json'), 'utf8'))
    expect(durable).toMatchObject({ record: { content: 'shared body', updated: { source: 'member', userId: 9 } } })
  } finally {
    await application.dispose()
    await rm(storageRoot, { recursive: true, force: true })
  }
}, 30_000)
