/** Compiled MCP ownership must recover from a failed Agent cleanup report. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'dsh-built-mcp-cleanup-'))
const occupied = new Set()
let unavailable = true, allocations = 0
try {
  provideWorkingDirectoryFixture(ctx, root)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(BrowserUse)
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    assert.equal(request.kind, 'process')
    assert.equal(request.sessionId, 'compiled-browser-failure')
    const allocation = ++allocations
    occupied.add(allocation)
    return {
      signal: new AbortController().signal,
      async release() {
        if (unavailable) throw new Error('compiled browser completion report unavailable')
        occupied.delete(allocation)
      },
      async uncertain() { assert.fail('compiled browser process was not confirmed stopped') },
    }
  } })
  const provider = ctx.plugin({
    name: 'compiled-browser-owner', inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
    apply(inner) {
      mountSessionMcp(inner, { name: 'compiled-browser', exclusive: true, command: process.execPath,
        args: [fileURLToPath(new URL('../mcp-fixture.mjs', import.meta.url)), root, 'fail'] })
    },
  })
  await provider
  await assert.rejects(ctx.agents.create({ sessionId: SessionId('compiled-browser-failure') }))
  assert.equal(allocations, 1)
  assert.equal(occupied.size, 1)
  const blocked = await ctx.agents.create({ sessionId: SessionId('compiled-browser-blocked') })
  assert.equal(ctx.tools.schemas(blocked.agent).some(tool => tool.name.startsWith('mcp__compiled-browser__')), false)
  assert.equal(allocations, 1)
  unavailable = false
  await provider.dispose()
  assert.equal(occupied.size, 0)
  assert.equal(ctx.browserUse.providerName, undefined)
  await blocked.dispose()
  process.stdout.write(JSON.stringify({ occupied: occupied.size, allocations, registrationReleased: true }) + '\n')
} finally {
  unavailable = false
  try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
}
