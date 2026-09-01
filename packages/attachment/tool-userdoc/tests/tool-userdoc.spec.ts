import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DOCUMENT_NOT_FOUND_CODE, DOCUMENT_READ_FAILED_CODE, UserDocError, UserDocId, type UserDocRef, type UserDocStore } from '@deepseek-ai/dsh-userdoc'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolUserDoc from '@deepseek-ai/dsh-tool-userdoc'
import { USERDOC_NOT_TEXT_CODE, USERDOC_PERSONAL_SCOPE_UNAVAILABLE_CODE, USERDOC_TOOL_FAILED_CODE, USERDOC_TOOL_NO_AGENT_CODE } from '../src/index.ts'

const LIMITS = {
  maxListResults: 3,
  maxReadBytes: 32,
  maxReadLines: 20,
  maxOutputBytes: 4096,
}

const refs: UserDocRef[] = [
  {
    docId: UserDocId('reports/annual.txt'),
    path: '/home/alice/documents/reports/annual.txt',
    name: 'annual.txt',
    bytes: 12,
    mediaType: 'text/plain',
    modifiedAt: 2,
  },
  {
    docId: UserDocId('notes.txt'),
    path: '/home/alice/documents/notes.txt',
    name: 'notes.txt',
    bytes: 8,
    mediaType: 'text/plain',
    modifiedAt: 3,
  },
  {
    docId: UserDocId('reports/预算.txt'),
    path: '/home/alice/documents/reports/预算.txt',
    name: '预算.txt',
    bytes: 10,
    mediaType: 'text/plain',
    modifiedAt: 1,
  },
  {
    docId: UserDocId('archive.bin'),
    path: '/home/alice/documents/archive.bin',
    name: 'archive.bin',
    bytes: 3,
    mediaType: 'application/octet-stream',
    modifiedAt: 0,
  },
]

function stream(value: Uint8Array, pending = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (pending) return
      controller.enqueue(value)
      controller.close()
    },
  })
}

function fakeStore(contents: Map<string, Uint8Array> = new Map()): UserDocStore {
  return {
    limits: {
      maxFileBytes: null,
      maxFilesPerMessage: 20,
      maxMessageBytes: 200,
      maxInlineTextBytes: 256,
      upload: { protocol: 'resumable-v1', chunkBytes: 65536, sessionTtlMs: 86_400_000, resumable: true },
    },
    list: vi.fn(async () => refs),
    stat: vi.fn(async (id: UserDocId) => {
      const ref = refs.find(candidate => candidate.docId === id)
      if (ref === undefined) throw new Error(`missing ${String(id)}`)
      return ref
    }),
    openRead: vi.fn(async (id: UserDocId) => {
      const ref = refs.find(candidate => candidate.docId === id)
      if (ref === undefined) throw new Error(`missing ${String(id)}`)
      return { ref, body: stream(contents.get(String(id)) ?? new TextEncoder().encode('one\ntwo\nthree')) }
    }),
  } as unknown as UserDocStore
}

function fakeAgent(ctx: Context, id = 'tool-userdoc-session'): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/home/alice' } })
  return { id: session.id, session } as unknown as Agent
}

async function setup(store = fakeStore()): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('userDocs', store as never)
  await ctx.plugin(ToolUserDoc, LIMITS)
  return { ctx, agent: fakeAgent(ctx) }
}

let calls = 0
function call(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`userdoc-call-${String(++calls)}`),
    name,
    arguments: args,
    agent,
  })
}

function text(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('personal user-document tool registration', () => {
  it('registers discovery/read schemas and model guidance', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['userdoc_list', 'userdoc_read'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('use userdoc_list to find it')
    expect(prompt).toContain('These tools are for personal sessions')
  })

  it('removes schemas and guidance when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('userDocs', fakeStore() as never)
    const fiber = await ctx.plugin(ToolUserDoc, LIMITS)
    expect(ctx.tools.schemas()).toHaveLength(2)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('userdoc_list')
  })

  it('waits for the required userDocs service instead of registering early', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolUserDoc, LIMITS)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('rejects invalid configuration values', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('userDocs', fakeStore() as never)
    await expect(ctx.plugin(ToolUserDoc, { ...LIMITS, maxListResults: 0 })).rejects.toThrow(/maxListResults/)
    await expect(ctx.plugin(ToolUserDoc, { ...LIMITS, timeoutMs: 2_147_483_648 })).rejects.toThrow(/timeoutMs/)
  })

  it('supports direct application with schema defaults and rejects an unsafe direct timeout', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('userDocs', fakeStore() as never)
    ToolUserDoc.apply(ctx, {})
    expect(ctx.tools.schemas()).toHaveLength(2)

    const invalid = new Context()
    await invalid.plugin(SystemPrompt)
    await invalid.plugin(ToolRuntime)
    invalid.provide('userDocs', fakeStore() as never)
    expect(() => { ToolUserDoc.apply(invalid, {
      maxListResults: 1,
      maxReadBytes: 1,
      maxReadLines: 1,
      maxOutputBytes: 1,
      timeoutMs: MAX_TIMER_DELAY_MS + 1,
    }) }).toThrow(/timeoutMs/)

    const invalidCap = new Context()
    await invalidCap.plugin(SystemPrompt)
    await invalidCap.plugin(ToolRuntime)
    invalidCap.provide('userDocs', fakeStore() as never)
    expect(() => { ToolUserDoc.apply(invalidCap, {
      maxListResults: 0,
      maxReadBytes: 1,
      maxReadLines: 1,
      maxOutputBytes: 1,
      timeoutMs: 1,
    }) }).toThrow(/maxListResults/)
  })
})

describe('userdoc_list', () => {
  it('lists all personal documents with folders and stable ids', async () => {
    const { ctx, agent } = await setup()
    const result = await call(ctx, agent, 'userdoc_list', {})
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Personal documents (1-3 of 4):')
    expect(text(result)).toContain('id: notes.txt')
    expect(text(result)).toContain('folder: reports')
    expect(text(result)).toContain('More documents are available. Call userdoc_list with offset=3.')
    expect(text(result)).not.toContain('/home/alice/documents')
  })

  it('filters by query and directory and pages the result', async () => {
    const { ctx, agent } = await setup()
    const result = await call(ctx, agent, 'userdoc_list', {
      query: '预算', directory: 'reports', offset: 0, limit: 1,
    })
    expect(text(result)).toContain('Personal documents (1-1 of 1):')
    expect(text(result)).toContain('id: reports/预算.txt')
  })

  it('reports an empty query result and validates path/number inputs', async () => {
    const { ctx, agent } = await setup()
    expect(text(await call(ctx, agent, 'userdoc_list', { query: 'missing' }))).toBe('No personal documents matched "missing".')
    for (const args of [
      { directory: '../private' },
      { directory: 'reports\\nested' },
      { query: '\u0000' },
      { offset: -1 },
      { limit: 4 },
    ]) {
      const result = await call(ctx, agent, 'userdoc_list', args)
      expect(result.isError).toBe(true)
    }
  })

  it('requires an owning agent and refuses project runtimes', async () => {
    const { ctx } = await setup()
    const noAgent = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('userdoc-no-agent'),
      name: 'userdoc_list',
      arguments: {},
    })
    expect(noAgent.isError).toBe(true)
    if (noAgent.isError) expect(noAgent.error.info).toMatchObject({ code: USERDOC_TOOL_NO_AGENT_CODE })
    ctx.provide('gatewayRuntime', { identity: { kind: 'project' } } as never)
    const project = await call(ctx, fakeAgent(ctx, 'project-session'), 'userdoc_list', {})
    expect(project.isError).toBe(true)
    if (project.isError) {
      expect(project.error.info).toMatchObject({ code: USERDOC_PERSONAL_SCOPE_UNAVAILABLE_CODE })
    }
  })

  it('translates provider failures without exposing storage diagnostics', async () => {
    const providerFailure = fakeStore()
    vi.spyOn(providerFailure, 'list').mockRejectedValue(new UserDocError('/private/documents', DOCUMENT_READ_FAILED_CODE))
    const { ctx: providerCtx, agent: providerAgent } = await setup(providerFailure)
    const providerResult = await call(providerCtx, providerAgent, 'userdoc_list', {})
    expect(providerResult.isError).toBe(true)
    if (providerResult.isError) {
      expect(providerResult.error.info).toMatchObject({ code: DOCUMENT_READ_FAILED_CODE })
      expect(text(providerResult)).not.toContain('/private/documents')
    }

    const missingProvider = fakeStore()
    vi.spyOn(missingProvider, 'list').mockRejectedValue(new UserDocError('/private/missing', DOCUMENT_NOT_FOUND_CODE))
    const { ctx: missingCtx, agent: missingAgent } = await setup(missingProvider)
    const missingResult = await call(missingCtx, missingAgent, 'userdoc_list', {})
    expect(missingResult.isError).toBe(true)
    if (missingResult.isError) {
      expect(missingResult.error.info).toMatchObject({ code: DOCUMENT_NOT_FOUND_CODE })
      expect(text(missingResult)).toContain('personal document was not found')
      expect(text(missingResult)).not.toContain('/private/missing')
    }

    const unknownFailure = fakeStore()
    vi.spyOn(unknownFailure, 'list').mockRejectedValue(new Error('/private/secret'))
    const { ctx: unknownCtx, agent: unknownAgent } = await setup(unknownFailure)
    const unknownResult = await call(unknownCtx, unknownAgent, 'userdoc_list', {})
    expect(unknownResult.isError).toBe(true)
    if (unknownResult.isError) {
      expect(unknownResult.error.info).toMatchObject({ code: USERDOC_TOOL_FAILED_CODE })
      expect(text(unknownResult)).not.toContain('/private/secret')
    }

    const harnessFailure = fakeStore()
    vi.spyOn(harnessFailure, 'list').mockRejectedValue(new HarnessError('/private/harness', 'PROVIDER_FAILURE'))
    const { ctx: harnessCtx, agent: harnessAgent } = await setup(harnessFailure)
    const harnessResult = await call(harnessCtx, harnessAgent, 'userdoc_list', {})
    expect(harnessResult.isError).toBe(true)
    if (harnessResult.isError) {
      expect(harnessResult.error.info).toMatchObject({ code: USERDOC_TOOL_FAILED_CODE })
      expect(text(harnessResult)).not.toContain('/private/harness')
    }
  })
})

describe('userdoc_read', () => {
  it('returns line-numbered UTF-8 content and supports continuation offsets', async () => {
    const contents = new Map([['reports/annual.txt', new TextEncoder().encode('第一行\n第二行\n第三行')]])
    const { ctx, agent } = await setup(fakeStore(contents))
    const result = await call(ctx, agent, 'userdoc_read', { doc_id: 'reports/annual.txt', limit: 2 })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('1: 第一行')
    expect(text(result)).toContain('2: 第二行')
    expect(text(result)).toContain('offset=3')
    expect(text(result)).not.toContain('/home/alice/documents')
    const next = await call(ctx, agent, 'userdoc_read', { doc_id: 'reports/annual.txt', offset: 3 })
    expect(text(next)).toContain('3: 第三行')
  })

  it('bounds a stream, preserves UTF-8 boundaries, and reports an empty window', async () => {
    const contents = new Map([['notes.txt', new TextEncoder().encode('🙂'.repeat(20))]])
    const { ctx, agent } = await setup(fakeStore(contents))
    const bounded = await call(ctx, agent, 'userdoc_read', { doc_id: 'notes.txt' })
    expect(text(bounded)).not.toContain('\uFFFD')
    expect(text(bounded)).toContain('More content is available.')
    const empty = await call(ctx, agent, 'userdoc_read', { doc_id: 'notes.txt', offset: 99 })
    expect(text(empty)).toContain('No lines available at offset 99.')
  })

  it('rejects malformed ids, binary content, and invalid windows', async () => {
    const contents = new Map([['archive.bin', new Uint8Array([0xff, 0xfe, 0xfd])]])
    const { ctx, agent } = await setup(fakeStore(contents))
    const binary = await call(ctx, agent, 'userdoc_read', { doc_id: 'archive.bin' })
    expect(binary.isError).toBe(true)
    if (binary.isError) {
      expect(binary.error.info).toMatchObject({ code: USERDOC_NOT_TEXT_CODE })
    }
    for (const args of [
      { doc_id: '../secret.txt' },
      { doc_id: 'reports\\annual.txt' },
      { doc_id: 'notes.txt', offset: 0 },
      { doc_id: 'notes.txt', offset: 1_000_001 },
      { doc_id: 'notes.txt', limit: 21 },
    ]) {
      const result = await call(ctx, agent, 'userdoc_read', args)
      expect(result.isError).toBe(true)
    }
  })

  it('sanitizes a stream failure after the provider opens a document', async () => {
    const provider = fakeStore()
    vi.spyOn(provider, 'openRead').mockResolvedValue({
      ref: refs[0]!,
      body: new ReadableStream<Uint8Array>({
        pull() { throw new Error('/private/stream-failure') },
      }),
    })
    const { ctx, agent } = await setup(provider)
    const result = await call(ctx, agent, 'userdoc_read', { doc_id: 'reports/annual.txt' })
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.info).toMatchObject({ code: USERDOC_TOOL_FAILED_CODE })
      expect(text(result)).not.toContain('/private/stream-failure')
    }
  })

  it('exposes generic read/search presentation intents', async () => {
    const { ctx } = await setup()
    const list = ctx.tools.get('userdoc_list')
    const read = ctx.tools.get('userdoc_read')
    expect(list?.isConcurrencySafe?.({})).toBe(true)
    expect(read?.isConcurrencySafe?.({ doc_id: 'notes.txt' })).toBe(true)
    expect(list?.presentCall?.({})).toMatchObject({ title: 'List personal documents' })
    expect(list?.presentCall?.({ query: 'annual' })).toMatchObject({ card: 'generic', kind: 'search' })
    expect(list?.presentCall?.({ query: '  ' })).toMatchObject({ title: 'List personal documents' })
    expect(read?.presentCall?.({ doc_id: 'reports/annual.txt', offset: 4 })).toMatchObject({
      card: 'generic', kind: 'read', locations: [{ path: 'reports/annual.txt', line: 4 }],
    })
    expect(read?.presentCall?.({ doc_id: 'notes.txt' })).toMatchObject({ locations: [{ line: 1 }] })
  })
})
