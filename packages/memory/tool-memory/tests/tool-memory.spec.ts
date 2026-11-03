import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MemorySwitches } from '@deepseek-ai/dsh-memory'
import { agentFor, fakeAuthority, memoryHarness, settingsStub } from '../../memory/tests/harness.ts'
import * as ToolMemory from '../src/index.ts'

const signal = new AbortController().signal
let callCounter = 0

/** Boot the tool plugin over a memory harness; `space` selects the service space. */
async function harness(options: {
  space?: 'personal' | 'project'
  authority?: ReturnType<typeof fakeAuthority>
  maxEntriesPerScope?: number
  switches?: MemorySwitches
} = {}) {
  const h = await memoryHarness({
    config: { space: options.space ?? 'personal', ...(options.maxEntriesPerScope !== undefined ? { maxEntriesPerScope: options.maxEntriesPerScope } : {}) },
    beforeService: (ctx) => {
      if (options.switches !== undefined) ctx.provide('settings', settingsStub(options.switches) as never)
      if (options.authority !== undefined) ctx.provide('executionAuthority', options.authority)
    },
  })
  await h.ctx.plugin(SystemPrompt)
  await h.ctx.plugin(ToolRuntime)
  const fiber = await h.ctx.plugin(ToolMemory)
  return { ...h, fiber }
}

/** Execute a memory tool through the real ToolRuntime pipeline. */
async function call(ctx: Context, name: string, args: Record<string, unknown>, agent: Agent) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const saveArgs = { scope: 'personal', key: 'release-freeze', kind: 'background', summary: 'freeze window', content: 'No deploys Friday.' }

describe('dsh-tool-memory', () => {
  it.each((['personal', 'workspace', 'project'] as const).flatMap(kind =>
    (['memory_read', 'memory_search'] as const).map(name => ({ kind, name }))))('withdraws pending $name in $kind when memory is disabled', async ({ kind, name }) => {
    const switches = { enabled: true, recall: false, extraction: false, consolidation: false }
    const h = await harness({ space: kind === 'project' ? 'project' : 'personal', switches, authority: fakeAuthority({ primaryActorUserId: 7 }) })
    const agent = agentFor(h.ctx, 'pending-memory-agent', { cwd: '/repo' })
    const args = kind === 'project' ? {} : { scope: kind }
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      expect((await call(h.ctx, 'memory_save', { ...saveArgs, ...args }, agent)).isError).toBe(false)
      if (name === 'memory_read') {
        const read = h.service.read.bind(h.service)
        vi.spyOn(h.service, 'read').mockImplementation(async (...input) => {
          const result = await read(...input)
          entered.resolve(undefined); await release.promise
          return result
        })
      } else {
        const search = h.service.search.bind(h.service)
        vi.spyOn(h.service, 'search').mockImplementation(async (...input) => {
          const result = await search(...input)
          entered.resolve(undefined); await release.promise
          return result
        })
      }
      const pending = call(h.ctx, name, { ...args, ...(name === 'memory_read' ? { key: 'release-freeze' } : { query: 'freeze' }) }, agent)
      await entered.promise
      switches.enabled = false
      release.resolve(undefined)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe('Error: Saved memories are unavailable to this conversation.')
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('withdraws an implicit search spanning personal and workspace scopes during storage', async () => {
    const switches = { enabled: true, recall: false, extraction: false, consolidation: false }
    const h = await harness({ switches })
    const agent = agentFor(h.ctx, 'pending-multi-scope-agent', { cwd: '/repo' })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      for (const scope of ['personal', 'workspace']) {
        expect((await call(h.ctx, 'memory_save', { ...saveArgs, scope }, agent)).isError).toBe(false)
      }
      const search = h.service.search.bind(h.service)
      vi.spyOn(h.service, 'search').mockImplementation(async (...args) => {
        expect(args[0].map(scope => scope.kind)).toEqual(['personal', 'workspace'])
        const result = await search(...args)
        expect(Array.isArray(result) && result.length === 2).toBe(true)
        entered.resolve(undefined); await release.promise
        return result
      })
      const pending = call(h.ctx, 'memory_search', { query: 'freeze' }, agent)
      await entered.promise
      switches.enabled = false
      release.resolve(undefined)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe('Error: Saved memories are unavailable to this conversation.')
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each([
    { space: 'personal', scope: { kind: 'personal' }, args: { scope: 'personal' } },
    { space: 'personal', scope: { kind: 'workspace', directory: '/repo' }, args: { scope: 'workspace' } },
    { space: 'project', scope: { kind: 'project' }, args: {} },
  ] as const)('withdraws every model tool in $scope.kind scope while owner reads retain entries', async ({ space, scope, args }) => {
    const switches = { enabled: true, extraction: false, consolidation: false, recall: false }
    const h = await harness({ space, switches, authority: fakeAuthority({ primaryActorUserId: 7 }) })
    try {
      const agent = agentFor(h.ctx, 'disabled-memory-agent', { cwd: '/repo' })
      expect((await call(h.ctx, 'memory_save', { ...saveArgs, ...args }, agent)).isError).toBe(false)
      switches.enabled = false
      expect(h.service.scopesFor(agent)).toEqual([])
      for (const [name, input] of [
        ['memory_read', { ...args, key: 'release-freeze' }],
        ['memory_search', { ...args, query: 'freeze' }],
        ['memory_search', { query: 'freeze' }],
        ['memory_save', { ...saveArgs, ...args, key: 'blocked-write' }],
        ['memory_delete', { ...args, key: 'release-freeze' }],
      ] as const) {
        const result = await call(h.ctx, name, input, agent)
        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Error: Saved memories are unavailable to this conversation.')
      }
      expect((await h.service.memberRead({ scope, key: 'release-freeze' }))?.content).toBe('No deploys Friday.')
      expect(await h.service.read(scope, 'blocked-write')).toBeUndefined()
      switches.enabled = true
      for (const [name, input] of [
        ['memory_read', { ...args, key: 'release-freeze' }],
        ['memory_search', { ...args, query: 'freeze' }],
      ] as const) {
        const result = await call(h.ctx, name, input, agent)
        expect(result.isError).toBe(false)
        expect(textOf(result)).toContain(name === 'memory_read' ? 'No deploys Friday.' : 'freeze window')
      }
    } finally { await h.ctx.fiber.dispose() }
  })

  it('exposes scope enums on the write tools and an optional scope filter on search in personal space', async () => {
    const h = await harness()
    const schemas = h.ctx.tools.schemas()
    const save = schemas.find(s => s.name === 'memory_save')!.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] }
    expect(save.properties.scope?.enum).toEqual(['personal', 'workspace'])
    expect(save.required).toEqual(['scope', 'key', 'kind', 'summary', 'content'])
    expect(save.properties.kind?.enum).toEqual(['profile', 'guidance', 'background', 'resource'])
    const search = schemas.find(s => s.name === 'memory_search')!.parameters as { required: string[] }
    expect(search.required).toEqual(['query'])
    const del = schemas.find(s => s.name === 'memory_delete')!.parameters as { required: string[] }
    expect(del.required).toEqual(['scope', 'key'])
    await h.ctx.fiber.dispose()
  })

  it('omits the scope parameter entirely in project space', async () => {
    const h = await harness({ space: 'project', authority: fakeAuthority({ primaryActorUserId: 7 }) })
    for (const name of ['memory_save', 'memory_read', 'memory_delete']) {
      const params = h.ctx.tools.schemas().find(s => s.name === name)!.parameters as { properties: Record<string, unknown> }
      expect(params.properties.scope).toBeUndefined()
    }
    await h.ctx.fiber.dispose()
  })

  it('saves, reads, searches, and deletes through the executor with exact render text', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const created = await call(h.ctx, 'memory_save', saveArgs, agent)
    expect(created.isError).toBe(false)
    expect(textOf(created)).toMatch(/^Created memory "release-freeze" in the personal scope \(revision .+\)\.$/)

    const read = await call(h.ctx, 'memory_read', { scope: 'personal', key: 'release-freeze' }, agent)
    const readText = textOf(read)
    expect(readText).toMatch(/^<memory key="release-freeze" scope="personal" kind="background" /)
    expect(readText).toMatch(/updated="\d{4}-\d{2}-\d{2}" revision="[^"]+">/)
    expect(readText).toContain('No deploys Friday.')
    expect(readText).toMatch(/<\/memory>$/)

    const search = await call(h.ctx, 'memory_search', { query: 'freeze' }, agent)
    expect(textOf(search)).toContain('<memory_search query="freeze">')
    expect(textOf(search)).toContain('- `release-freeze` (personal) [background,')

    const revision = /revision="([^"]+)"/.exec(readText)![1]
    const deleted = await call(h.ctx, 'memory_delete', { scope: 'personal', key: 'release-freeze', revision }, agent)
    expect(textOf(deleted)).toBe('Deleted memory "release-freeze" from the personal scope.')
    await h.ctx.fiber.dispose()
  })

  it('renders no-match search and the memory_read not_found refusal', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const search = await call(h.ctx, 'memory_search', { query: 'nothing' }, agent)
    expect(textOf(search)).toBe('No saved memory matches "nothing".')
    const read = await call(h.ctx, 'memory_read', { scope: 'personal', key: 'missing-key' }, agent)
    expect(read.isError).toBe(true)
    expect(textOf(read)).toBe('Error: No saved memory has the key "missing-key" in the personal scope.')
    await h.ctx.fiber.dispose()
  })

  it('renders memory_exists, memory_stale, memory_full, and invalid-key refusals verbatim', async () => {
    const h = await harness({ maxEntriesPerScope: 2 })
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    await call(h.ctx, 'memory_save', saveArgs, agent)
    const dup = await call(h.ctx, 'memory_save', saveArgs, agent)
    expect(dup.isError).toBe(true)
    expect(textOf(dup)).toBe('Error: A memory with the key "release-freeze" already exists in the personal scope. Read it with memory_read and pass its revision to replace it, or choose another key.')

    const stale = await call(h.ctx, 'memory_save', { ...saveArgs, revision: 'stale-rev' }, agent)
    expect(textOf(stale)).toBe('Error: The memory "release-freeze" changed after revision stale-rev. Read it again with memory_read before changing it.')

    await call(h.ctx, 'memory_save', { ...saveArgs, key: 'second-key' }, agent)
    const full = await call(h.ctx, 'memory_save', { ...saveArgs, key: 'third-key' }, agent)
    expect(textOf(full)).toBe('Error: This memory scope already holds 2 memories. Delete or merge memories that are no longer useful before saving a new one.')

    const bad = await call(h.ctx, 'memory_save', { ...saveArgs, key: 'Bad Key!' }, agent)
    expect(textOf(bad)).toBe('Error: The key "Bad Key!" is invalid: use lowercase letters, digits, and single hyphens, at most 64 characters.')
    await h.ctx.fiber.dispose()
  })

  it('refuses the workspace scope without a working directory', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent')
    const read = await call(h.ctx, 'memory_read', { scope: 'workspace', key: 'any-key' }, agent)
    expect(read.isError).toBe(true)
    expect(textOf(read)).toBe('Error: This conversation has no working directory, so the workspace scope is unavailable.')
    await h.ctx.fiber.dispose()
  })

  it('rethrows project authorization denial as execution/forbidden through the executor', async () => {
    const h = await harness({
      space: 'project',
      authority: fakeAuthority(new RemoteError('execution/forbidden', 'policy denied', { capability: 'memory' })),
    })
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const result = await call(h.ctx, 'memory_save', { key: 'team-fact', kind: 'background', summary: 's', content: 'c' }, agent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Error: Changing project memory is not permitted in this conversation. '
      + 'An administrator must enable memory writing for this project and for every participant, and private conversations can only read project memory.')
    await h.ctx.fiber.dispose()
  })

  it('publishes the tool:memory guidance section when memory_save is visible', async () => {
    const h = await harness()
    const assembly = await h.ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'tool:memory')
    expect(section).toBeDefined()
    expect(section!.text).toContain('Saved memories carry knowledge between conversations.')
    expect(section!.text).toContain('Use the personal scope for facts about the user that apply in every workspace, and the workspace scope for facts specific to this conversation\'s working directory.')
    await h.ctx.fiber.dispose()
  })

  it('uses the project closing guidance in project space', async () => {
    const h = await harness({ space: 'project', authority: fakeAuthority({ primaryActorUserId: 7 }) })
    const assembly = await h.ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'tool:memory')
    expect(section!.text).toContain('Project memories are shared with every member of this project. Save what will help the team\'s later conversations, and write each memory so that someone who did not see this conversation understands it.')
    await h.ctx.fiber.dispose()
  })

  it('disposes tools and the guidance section with the plugin fiber', async () => {
    const h = await harness()
    expect(h.ctx.tools.get('memory_save')).toBeDefined()
    await h.fiber.dispose()
    expect(h.ctx.tools.get('memory_save')).toBeUndefined()
    expect(h.ctx.tools.get('memory_search')).toBeUndefined()
    const assembly = await h.ctx.systemPrompt.assemble()
    expect(assembly.sections.find(s => s.name === 'tool:memory')).toBeUndefined()
    await h.ctx.fiber.dispose()
  })
  it('throws the fixed wiring error when no agent stands behind a call', async () => {
    const h = await harness()
    const result = await h.ctx.tools.execute({
      signal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'memory_read',
      arguments: { scope: 'personal', key: 'k' },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Error: memory tools require a calling agent')
    await h.ctx.fiber.dispose()
  })

  it('writes into the session workspace scope and refuses foreign mismatches upstream', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const saved = await call(h.ctx, 'memory_save', { ...saveArgs, scope: 'workspace', key: 'ws-fact' }, agent)
    expect(saved.isError).toBe(false)
    expect(textOf(saved)).toMatch(/^Created memory "ws-fact" in the workspace scope \(revision .+\)\.$/)
    expect(await h.service.read({ kind: 'workspace', directory: '/repo' }, 'ws-fact')).toBeDefined()
    await h.ctx.fiber.dispose()
  })

  it('renders memory_not_found, summary, and content refusals verbatim', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const missing = await call(h.ctx, 'memory_save', { ...saveArgs, revision: 'rev-x' }, agent)
    expect(textOf(missing)).toBe('Error: No saved memory has the key "release-freeze" in the personal scope.')
    const summary = await call(h.ctx, 'memory_save', { ...saveArgs, summary: 'a\nb' }, agent)
    expect(textOf(summary)).toBe(`Error: The summary must be one line of 1 to ${h.service.limits.summaryMaxChars} characters.`)
    const content = await call(h.ctx, 'memory_save', { ...saveArgs, content: '  ' }, agent)
    expect(textOf(content)).toBe('Error: The content must not be empty and must fit in 8192 bytes of UTF-8.')
    const gone = await call(h.ctx, 'memory_delete', { scope: 'personal', key: 'absent' }, agent)
    expect(textOf(gone)).toBe('Error: No saved memory has the key "absent" in the personal scope.')
    await h.ctx.fiber.dispose()
  })

  it('searches every offered scope when the scope argument is omitted and refuses empty queries', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    await h.service.save({ scope: { kind: 'workspace', directory: '/repo' }, key: 'ws-fact', kind: 'guidance', summary: 'workspace needle', content: 'x' }, { kind: 'agent', agent })
    const search = await call(h.ctx, 'memory_search', { query: 'needle' }, agent)
    expect(textOf(search)).toContain('- `ws-fact` (workspace) [guidance,')
    const empty = await call(h.ctx, 'memory_search', { query: '   ' }, agent)
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toBe('Error: The query must contain at least one word.')
    await h.ctx.fiber.dispose()
  })

  it('rethrows non-forbidden failures without rewriting the message', async () => {
    const h = await harness({
      space: 'project',
      authority: fakeAuthority(new Error('service down')),
    })
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const result = await call(h.ctx, 'memory_save', { key: 'team-fact', kind: 'background', summary: 's', content: 'c' }, agent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Error: service down')
    await h.ctx.fiber.dispose()
  })

  it('renders updates, diffs, and the scope-free project variants', async () => {
    const h = await harness({ space: 'project', authority: fakeAuthority({ primaryActorUserId: 3 }) })
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    const created = await call(h.ctx, 'memory_save', { key: 'team-fact', kind: 'guidance', summary: 'team rule', content: 'v1 body' }, agent)
    expect(textOf(created)).toMatch(/^Created memory "team-fact" \(revision .+\)\.$/)

    const read = await call(h.ctx, 'memory_read', { key: 'team-fact' }, agent)
    const readText = textOf(read)
    expect(readText).toMatch(/^<memory key="team-fact" kind="guidance" /)
    const revision = /revision="([^"]+)"/.exec(readText)![1]

    const updated = await call(h.ctx, 'memory_save', { key: 'team-fact', kind: 'guidance', summary: 'team rule', content: 'v2 body', revision }, agent)
    expect(textOf(updated)).toMatch(/^Updated memory "team-fact" \(revision .+\)\.$/)

    const search = await call(h.ctx, 'memory_search', { query: 'team' }, agent)
    expect(textOf(search)).toContain('- `team-fact` [guidance,')
    expect(textOf(search)).not.toContain('(project)')

    const reread = textOf(await call(h.ctx, 'memory_read', { key: 'team-fact' }, agent))
    const current = /revision="([^"]+)"/.exec(reread)![1]
    const deleted = await call(h.ctx, 'memory_delete', { key: 'team-fact', revision: current }, agent)
    expect(textOf(deleted)).toBe('Deleted memory "team-fact".')
    await h.ctx.fiber.dispose()
  })

  it('presents the save card and result diff through the tool definition', async () => {
    const h = await harness()
    const args = { scope: 'personal', key: 'k', kind: 'guidance', summary: 's', content: 'new body' }
    const save = h.ctx.tools.get('memory_save')!
    expect(save.presentCall?.(args)).toMatchObject({
      card: 'diff',
      title: 'Save memory k',
      diffs: [{ path: 'memory/personal/k', oldText: null, newText: 'new body' }],
    })
    const presentResult = save.presentResult?.bind(save) as ((a: unknown, r: unknown) => unknown) | undefined
    expect(presentResult?.(args, { isError: true })).toBeUndefined()
    expect(presentResult?.(args, {
      isError: false,
      meta: { path: 'memory/personal/k', oldText: 'old', newText: 'new' },
    })).toMatchObject({ diffs: [{ path: 'memory/personal/k', oldText: 'old', newText: 'new' }] })
    await h.ctx.fiber.dispose()

    const project = await harness({ space: 'project', authority: fakeAuthority({ primaryActorUserId: 1 }) })
    const projectSave = project.ctx.tools.get('memory_save')!
    const projectArgs = { key: 'k', kind: 'guidance', summary: 's', content: 'fallback' }
    expect(projectSave.presentCall?.(projectArgs))
      .toMatchObject({ diffs: [{ path: 'memory/project/k', oldText: null, newText: 'fallback' }] })
    const projectResult = projectSave.presentResult?.bind(projectSave) as ((a: unknown, r: unknown) => unknown) | undefined
    expect(projectResult?.(projectArgs, { isError: false }))
      .toMatchObject({ diffs: [{ path: 'memory/project/k', oldText: null, newText: 'fallback' }] })
    await project.ctx.fiber.dispose()
  })

  it('declares search and read concurrency-safe and hides the guidance when memory_save is restricted', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'tool-agent', { cwd: '/repo' })
    expect(h.ctx.tools.get('memory_search')?.isConcurrencySafe?.({ query: 'q' })).toBe(true)
    expect(h.ctx.tools.get('memory_read')?.isConcurrencySafe?.({ scope: 'personal', key: 'k' })).toBe(true)

    // A scoped restriction resolves to no memory_save, so the section renders ''.
    let scope!: Scope
    await h.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt', 'memory'] }))
    scope.ctx.tools.restrict({ deny: ['memory_save'] })
    const assembly = await h.ctx.systemPrompt.assemble({ scope: agent })
    const section = assembly.sections.find(s => s.name === 'tool:memory')
    expect(section?.text ?? '').toBe('')
    await h.ctx.fiber.dispose()
  })

  it('maps service-side scope refusals and the fallback arm onto tool text', async () => {
    // resolveScope already filters scopes the tools may name, so the
    // remaining memory_invalid reasons are exercised through a stub service.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const base = {
      space: 'personal' as const,
      limits: { entryMaxBytes: 100, summaryMaxChars: 20, maxEntriesPerScope: 10, searchMaxResults: 5 },
      scopesFor: () => [{ kind: 'personal' as const }],
      save: async () => ({ ok: false as const, code: 'memory_invalid' as const, reason: 'scope-unavailable' as const }),
      delete: async () => ({ ok: false as const, code: 'memory_invalid' as const, reason: 'workspace-mismatch' as const }),
    }
    let refusal: { ok: false; code: 'memory_invalid'; reason: 'scope-unavailable' | 'workspace-mismatch' | 'query' } =
      { ok: false, code: 'memory_invalid', reason: 'scope-unavailable' }
    ctx.provide('memory', { ...base, save: async () => refusal, delete: async () => refusal })
    const fiber = await ctx.plugin(ToolMemory)
    const agent = agentFor(ctx, 'tool-agent', { cwd: '/repo' })

    const unavailable = await call(ctx, 'memory_save', saveArgs, agent)
    expect(textOf(unavailable)).toBe('Error: This conversation has no working directory, so the workspace scope is unavailable.')

    refusal = { ok: false, code: 'memory_invalid', reason: 'workspace-mismatch' }
    const mismatch = await call(ctx, 'memory_delete', { scope: 'personal', key: 'k' }, agent)
    expect(textOf(mismatch)).toBe('Error: This conversation can change only the workspace memory of its own working directory.')

    refusal = { ok: false, code: 'memory_invalid', reason: 'query' }
    const fallback = await call(ctx, 'memory_save', saveArgs, agent)
    expect(textOf(fallback)).toBe('Error: The memory request was invalid.')

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
