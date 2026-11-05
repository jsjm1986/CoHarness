import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionBackedInbox } from '../../../core/agent-loop/tests/inbox-helpers.ts'
/**
 * Web session model-directory and selection behavior: dynamic provider grouping,
 * provider-local catalog failures, logged-selection restoration without stale
 * catalog injection, advisory pass-through models, and the prompt-assembly
 * boundary for a running selection change.
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import { collaborationCapabilities } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import ModelAccessPolicy from '@deepseek-ai/dsh-model-access'
import type {
  GenerateOptions, LlmCallConfig, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo,
  LlmResolvedModelInfo, StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'
import { admittedPrompts } from '../src/prompt-receipts.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`models-${String(nextRpc++)}`), payload }
}

class CatalogAdapter extends LlmAdapter {
  constructor(
    private readonly name: string,
    private readonly models: readonly LlmModelInfo[] | Error,
    private readonly reasoning?: LlmModelReasoningInfo,
    private readonly exactError?: Error,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.name }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return this.models instanceof Error
      ? Promise.reject(this.models)
      : Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.exactError !== undefined) return Promise.reject(this.exactError)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Catalog tests never enter provider streaming.
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

async function harness(logged?: {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  adapterDefaults?: { reasoningEffort?: true }
}, options?: { withRegistry?: boolean; persistenceRoot?: string }): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (options?.withRegistry === true) await ctx.plugin(SessionProjectionRegistry)
  ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    {
      provider: 'deepseek-official',
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      description: 'Reasoning model',
      inputModalities: ['text', 'image'],
    },
  ], REASONING))
  ctx.llm.registerAdapter(['broken'], new CatalogAdapter('Broken Provider', new Error('catalog offline')))
  ctx.llm.registerAdapter(['metadata-broken'], new CatalogAdapter('Metadata Broken', [
    { provider: 'metadata-broken', id: 'listed', name: 'Listed' },
  ], undefined, new Error('reasoning metadata offline')))
  ctx.llm.registerAdapter(['empty'], new CatalogAdapter('Empty Provider', []))
  ctx.llm.registerAdapter(['duplicate'], new CatalogAdapter('Duplicate Provider', [
    { provider: 'duplicate', id: 'same', name: 'Same' },
    { provider: 'duplicate', id: 'same', name: 'Same Again' },
  ]))
  if (options?.persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: options.persistenceRoot, compression: 'none' })
  const session = ctx.sessions.create()
  if (logged !== undefined) {
    const { adapterDefaults, ...config } = logged
    session.append('request/header', {
      header: { config, ...adapterDefaults === undefined ? {} : { adapterDefaults } },
      reason: 'initial',
    })
  }
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  await ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

function expectValue<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  if (!response.result.ok) throw new Error('expected successful response')
  return response.result.value
}

function registerTextOnly(ctx: Context): void {
  ctx.llm.registerAdapter(['text-only'], new class extends CatalogAdapter {
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
    }
  }('Text Only', []))
}

describe('Web session model selection', () => {
  it('validates an ordered image batch before persisting any member', async () => {
    const { ctx, agent, sessionId } = await harness()
    const validateImage = vi.fn((_input: { data: Uint8Array }) => Promise.resolve())
    const saveImage = vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
      attachmentId: `att-${String(input.data[0])}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 4,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage,
      saveImage,
      validateImageBatch(inputs: readonly unknown[]) {
        (AttachmentStore.prototype as unknown as { validateImageBatch(this: unknown, batch: readonly unknown[]): void })
          .validateImageBatch.call(attachments, inputs)
      },
    }
    ctx.provide('attachments', {
      ...attachments,
      saveImages(inputs: readonly Parameters<typeof saveImage>[0][]) {
        return AttachmentStore.prototype.saveImages.call(attachments, inputs)
      },
      admitPromptContent(parts: readonly unknown[]) {
        return (AttachmentStore.prototype.admitPromptContent as (this: unknown, content: readonly unknown[]) => Promise<unknown[]>)
          .call(attachments, parts)
      },
    } as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'first.png' },
        { type: 'text' as const, text: 'compare' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'Ag==' },
      ],
    }))
    expect(result.result.ok).toBe(true)
    expect(validateImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect(saveImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'first.png',
        },
      },
      { type: 'text', text: 'compare' },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])

    const denied = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: Array.from({ length: 3 }, () => ({
        type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==',
      })),
    }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'TOO_MANY_IMAGES' } },
    })
    expect(saveImage).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('refuses a text-only selection while durable or pending image content remains visible', async () => {
    const { ctx, agent, sessionId } = await harness()
    registerTextOnly(ctx)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'att-history', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
    }
    agent.session.append('user/message', {
      id: 'image-message', role: 'user', source: { kind: 'user' }, content: [image],
    } as never, { surfaceOp: 'append' })
    expect((await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).result).toMatchObject({ ok: false, error: { code: 'model-unavailable' } })

    agent.session.append('user/message', {
      id: 'summary', role: 'user', source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'image summarized' }],
    } as never, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(agent.session.seq - 1) },
      sourceEventSeqs: agent.session.snapshotEvents().map(event => event.seq),
    })
    ;(agent.inbox.nextTurn as UserMessage[]).push({
      id: 'pending-image', role: 'user', source: { kind: 'user' }, content: [image],
    } as never)
    expect((await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).result.ok).toBe(false)
    ;(agent.inbox.nextTurn as UserMessage[]).length = 0
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })
    await ctx.fiber.dispose()
  })

  it('authorizes attachment bytes only when the session event stream references the id', async () => {
    const { ctx, agent, sessionId } = await harness()
    const ref = {
      attachmentId: 'att-authorized', mediaType: 'image/png' as const, bytes: 2, width: 1, height: 1,
    }
    const readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))
    ctx.provide('attachments', { readImage } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{
        id: 'queued-image', role: 'user', source: { kind: 'user' },
        content: [{ type: 'image', attachment: ref }],
      }],
    } as never)

    const allowed = await api.sessions.attachment(request({
      sessionId, attachmentId: 'att-authorized' as never,
    }))
    expect(allowed.result).toMatchObject({ ok: true, value: { attachment: ref, data: 'AQI=' } })
    const denied = await api.sessions.attachment(request({
      sessionId, attachmentId: 'att-other' as never,
    }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } },
    })
    expect(readImage).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
  it('groups successful providers and leaves an unlisted current selection out of the catalog', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: ReasoningEffortId('max'),
    })
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: '/tmp' })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.current).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    expect(catalog.groups).toEqual([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: REASONING },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: 'Reasoning model',
          inputModalities: ['text', 'image'],
          reasoning: REASONING,
        },
      ],
    }])
    const hostCatalog = expectValue(await api.llm.models(request({})))
    expect(hostCatalog.groups).toEqual(catalog.groups)
    expect(hostCatalog.failures).toEqual(catalog.failures)
    expect(catalog.failures).toEqual([
      { id: 'broken', name: 'Broken Provider', message: 'catalog offline' },
      { id: 'metadata-broken', name: 'Metadata Broken', message: 'reasoning metadata offline' },
      {
        id: 'duplicate',
        name: 'Duplicate Provider',
        message: 'adapter returned invalid or duplicate model metadata for provider "duplicate"',
      },
    ])
    await ctx.fiber.dispose()
  })

  it('accepts an advisory-unlisted model, rejects an unavailable provider, and switches only after the next assembly', async () => {
    const { ctx, agent, sessionId } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: '/tmp' })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })

    const selected = expectValue(await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })))
    expect(selected.selected).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })

    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'private-preview' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })

    const unsupported = await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'medium',
    }))
    expect(unsupported.result).toMatchObject({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'provider "deepseek-official" model "private-preview" does not support reasoning effort "medium"',
      },
    })

    const rejected = await api.sessions.selectModel(request({
      sessionId,
      provider: 'missing',
      model: 'model',
    }))
    expect(rejected.result).toEqual({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'no adapter registered for provider "missing"',
        details: { provider: 'missing', model: 'model' },
      },
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'private-preview', reasoningEffort: 'max' })
    await ctx.fiber.dispose()
  })

  it('reads the Agent default live for a session whose log names no selection', async () => {
    const { ctx, sessionId } = await harness()
    let stored = { provider: 'deepseek-official', model: 'deepseek-chat' }
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => stored,
      cwd: '/tmp',
    })

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    // The default moving after the session exists still reaches it: New
    // Session reuses a blank session rather than minting another, so a seed
    // captured at creation would show the superseded model there.
    stored = { provider: 'deepseek-official', model: 'deepseek-reasoner' }
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    expect(expectValue(await api.host.describe(request({}))))
      .toMatchObject({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    await ctx.fiber.dispose()
  })

  it('keeps a session on its logged selection when the Agent default differs', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    let stored = { provider: 'deepseek-official', model: 'deepseek-chat' }
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => stored,
      cwd: '/tmp',
    })

    stored = { provider: 'duplicate', model: 'same' }
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await ctx.fiber.dispose()
  })

  it('saves an accepted selection as the default and survives a storage failure', async () => {
    const { ctx, sessionId } = await harness()
    const saved: unknown[] = []
    let reject = false
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      saveDefaultModelSelection: (selection) => {
        saved.push(selection)
        return reject ? Promise.reject(new Error('read-only document')) : Promise.resolve()
      },
      cwd: '/tmp',
    })

    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max',
    })))
    expect(saved).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' },
    ])

    // A refused selection never becomes anyone's default.
    await api.sessions.selectModel(request({ sessionId, provider: 'missing', model: 'model' }))
    expect(saved).toHaveLength(1)

    // Storage failing is not the selection failing: the switch already applies
    // to this session, so the call still succeeds.
    reject = true
    const stillAccepted = expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-chat',
    })))
    expect(stillAccepted.selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('keeps a project-scoped model switch local to its shared session', async () => {
    const { ctx, sessionId } = await harness()
    const authority: CollaborationAuthority = {
      participant: {
        userId: 7,
        username: 'alice',
        displayName: 'Alice',
        role: 'user',
        scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
      },
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      capabilities() { return collaborationCapabilities(this.participant) },
      authorize: id => Promise.resolve({
        sessionId: id,
        rootSessionId: id,
        mode: 'rw',
        canRead: true,
        canWrite: true,
        canManage: true,
        projectId: 41,
        visibility: 'project',
        creatorUserId: 7,
      }),
      readableSessionIds: ids => Promise.resolve(new Set(ids)),
      claimInteraction: () => Promise.resolve(true),
    }
    ctx.provide('collaboration', {
      capture: () => authority,
      currentCreation: () => undefined,
      withSessionCreation: (_creation: unknown, operation: () => Promise<unknown>) => operation(),
    } as never)
    const saveDefaultModelSelection = vi.fn(() => Promise.resolve())
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      saveDefaultModelSelection,
      cwd: '/tmp',
    })

    const selected = expectValue(await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
    })))

    expect(selected.selected).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
    })
    expect(saveDefaultModelSelection).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('filters, rejects selection, and refuses prompt execution under model policy', async () => {
    const { ctx, sessionId } = await harness()
    const denied = new Set(['deepseek-official/deepseek-reasoner'])
    new class extends ModelAccessPolicy {
      override decide(target: { provider: string; model: string }) {
        return denied.has(`${target.provider}/${target.model}`)
          ? { allowed: false as const, reason: `policy denies ${target.provider}/${target.model}` }
          : { allowed: true as const }
      }
    }(ctx)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)))
      .not.toContain('deepseek-official/deepseek-reasoner')
    expect(catalog.routable).toBe(true)

    const selection = await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    }))
    expect(selection.result).toEqual({
      ok: false,
      error: {
        code: 'model-forbidden',
        message: 'policy denies deepseek-official/deepseek-reasoner',
        details: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
      },
    })

    denied.add('deepseek-official/deepseek-chat')
    expect(expectValue(await api.sessions.models(request({ sessionId }))).routable).toBe(false)
    const prompt = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hi' }],
    }))
    expect(prompt.result).toMatchObject({
      ok: false,
      error: {
        code: 'model-forbidden',
        details: { provider: 'deepseek-official', model: 'deepseek-chat' },
      },
    })
    await ctx.fiber.dispose()
  })

  it('refuses a prompt no adapter can route, and reports it on the directory', async () => {
    const { ctx, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deleted-gateway', model: 'deleted-model' }),
      cwd: '/tmp',
    })

    // The client disabling its input is an affordance; this method stays
    // callable, so the refusal has to live here.
    const refused = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hi' }],
    }))
    expect(refused.result).toMatchObject({
      ok: false,
      error: { code: 'model-unavailable', details: { provider: 'deleted-gateway', model: 'deleted-model' } },
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).routable).toBe(false)

    // An advisory-unlisted model on a live route is NOT this: the route
    // serves it, so the prompt goes through and nothing blocks.
    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'unlisted-but-served',
    })))
    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.routable).toBe(true)
    expect(catalog.groups.flatMap(group => group.models.map(model => model.id)))
      .not.toContain('unlisted-but-served')
    await ctx.fiber.dispose()
  })

  it('serves a session and its catalog when the stored default names a route that is gone', async () => {
    const { ctx, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      // What a Models-page removal leaves behind: the settings document still
      // names the route the user last picked, and nothing serves it.
      defaultModelSelection: () => ({ provider: 'deleted-gateway', model: 'deleted-model' }),
      cwd: '/tmp',
    })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    // Passed through rather than repaired: matching no group is precisely what
    // makes the composer seat prompt for a selection instead of naming a model
    // the deployment cannot reach.
    expect(catalog.current).toEqual({ provider: 'deleted-gateway', model: 'deleted-model' })
    expect(catalog.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)))
      .not.toContain('deleted-gateway/deleted-model')
    await ctx.fiber.dispose()
  })

  it('logs a durable model/selection that never enters derived history', async () => {
    const { ctx, agent, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const before = agent.session.deriveMessages().length
    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max',
    })))
    const events = agent.session.snapshotEvents()
    const selections = events.filter(event => event.type === 'model/selection')
    expect(selections).toHaveLength(1)
    expect(selections[0]?.data).toEqual({
      provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max',
    })
    expect(agent.session.deriveMessages()).toHaveLength(before)
    await ctx.fiber.dispose()
  })

  it('restores a pending durable selection over the logged request header', async () => {
    const { ctx, agent, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    }, { withRegistry: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    agent.session.append('model/selection', {
      provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max',
    })

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' })
    expect(ctx.sessionProjections.snapshot(agent.session).values.modelSelection)
      .toEqual({
        lastUsed: { provider: 'deepseek-official', model: 'deepseek-chat' },
        next: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' },
      })
    await ctx.fiber.dispose()
  })

  it('lets a matching request header retire the pending selection', async () => {
    const { ctx, agent, sessionId } = await harness(undefined, { withRegistry: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high',
    })))
    // The header the pending selection produced retires it; a later request
    // header then drives the selection again instead of the stale pending one.
    agent.session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: ReasoningEffortId('high') } },
      reason: 'initial',
    })
    agent.session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } },
      reason: 'initial',
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await ctx.fiber.dispose()
  })

  it('keeps a pending selection when the request header names another route', async () => {
    const { ctx, agent, sessionId } = await harness(undefined, { withRegistry: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    })))
    // A request already in flight under the old route does not consume a
    // selection made for the next request.
    agent.session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } },
      reason: 'initial',
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('does not restore an adapter-defaulted effort as an explicit selection', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      reasoningEffort: ReasoningEffortId('high'),
      adapterDefaults: { reasoningEffort: true },
    }, { withRegistry: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    await ctx.fiber.dispose()
  })
})

it('acknowledges one persisted inbox insertion after a lost response and rejects changed input on the same operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-receipt-'))
  const { ctx, agent, sessionId } = await harness(undefined, { withRegistry: true, persistenceRoot: root })
  try {
    const writer = await ctx.sessionPersistence.create(agent.session.header)
    ctx.effect(() => () => writer.close())
    const inbox = sessionBackedInbox(agent)
    const followup = vi.fn((message: UserMessage) => { inbox.splice('next-turn', Infinity, 0, [message]) })
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: root })
    const id = RpcId('same-operation')
    const payload = { sessionId, requestId: id, mode: 'queue' as const, durable: true as const, content: [{ type: 'text' as const, text: 'one input' }] }
    const [first, retry] = await Promise.all([api.sessions.prompt(request(payload)),api.sessions.prompt(request(payload))])
    expect(first.result).toEqual({ ok: true, value: { accepted: true } })
    expect(retry.result).toEqual(first.result)
    expect(followup).toHaveBeenCalledTimes(1)
    expect((await api.sessions.prompt(request({ ...payload, content: [{ type: 'text', text: 'different' }] }))).result)
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(expectValue(await api.sessions.promptStatus(request({ sessionId, requestId: id })))).toEqual({ state: 'accepted' })
    const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    expect(expectValue(await api.sessions.promptStatus(request({ sessionId, requestId: id, confirmInput: true })))).toEqual({
      state: 'accepted', inputProof: sha([id, sha(['queue', null, payload.content])]),
    })
    expect(expectValue(await api.sessions.promptStatus(request({ sessionId, requestId: RpcId('unseen') })))).toEqual({ state: 'unknown' })
    const persisted = await ctx.sessionPersistence.readPage(sessionId)
    expect(persisted.events.filter(e => e.type === 'agent/inbox/spliced' && e.data.inserted.length > 0)).toHaveLength(1)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('verifies the exact durable inbox event while later Session events commit, and refuses an unverified prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-prefix-'))
  const { ctx, agent, sessionId } = await harness(undefined, { withRegistry: true, persistenceRoot: root })
  try {
    const writer = await ctx.sessionPersistence.create(agent.session.header)
    ctx.effect(() => () => writer.close())
    const inbox = sessionBackedInbox(agent)
    Object.assign(agent, { followup: (message: UserMessage) => { inbox.splice('next-turn', Infinity, 0, [message]) } })
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: root })
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const otherSession = ctx.sessions.create()
    const otherWriter = await ctx.sessionPersistence.create(otherSession.header)
    ctx.effect(() => () => otherWriter.close())
    await otherWriter.flush()
    const handleModes = ['concurrent', 'id', 'key', 'digest', 'close'] as const
    let mode: typeof handleModes[number] = 'concurrent'
    let advanced = false
    const openOverride = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      if (mode === 'id' && args[1] === 'read') return open(otherSession.id, 'read')
      const handle = await open(...args)
      if (args[1] !== 'read') return handle
      const read: typeof handle.read = async (...bounds) => {
        const page = await handle.read(...bounds)
        const [event] = page.events
        if (!event || event.type !== 'agent/inbox/spliced') return page
        if (mode === 'concurrent' && !advanced) {
          advanced = true
          agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 0, inserted: [] })
          await ctx.sessions.flush(agent.session)
        }
        const [proof] = admittedPrompts(event)
        if (!proof || mode !== 'key' && mode !== 'digest') return page
        const changed = { ...proof, [mode]: '0'.repeat(64) }
        const inserted = event.data.inserted.map(item => ({ ...item, source: { ...item.source, admission: changed } }))
        return { ...page, events: [{ ...event, data: { ...event.data, inserted } }] }
      }
      const close = async (): Promise<void> => {
        await handle.close()
        if (mode === 'close') throw new Error('read handle close failed')
      }
      return new Proxy(handle, {
        get(target, prop): unknown {
          if (prop === 'read') return read
          if (prop === 'close') return close
          return Reflect.get(target, prop, target) as unknown
        },
      })
    })
    const requestId = RpcId('concurrent-operation')
    const payload = { sessionId, requestId, mode: 'queue' as const, durable: true as const, content: [{ type: 'text' as const, text: 'one input' }] }
    expect((await api.sessions.prompt(request(payload))).result).toEqual({ ok: true, value: { accepted: true } })
    expect(advanced).toBe(true)
    const [marker] = Object.values(ctx.sessionProjections.stateOf(agent.session, 'acceptedPromptReceipts')!)
    advanced = false
    await expect(ctx.sessionPersistence.readPage(sessionId, { direction: 'newer', fromSeq: marker!.seq, maxEvents: 1 }))
      .rejects.toMatchObject({ code: 'dependency', message: 'session persistence revision changed during page read' })
    expect(advanced).toBe(true)
    for (const fault of handleModes.slice(1)) {
      mode = fault
      expect((await api.sessions.promptStatus(request({ sessionId, requestId }))).result).toMatchObject({
        ok: false, error: { code: 'prompt-durability-unavailable' },
      })
    }
    openOverride.mockRestore()
    const failedFlush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await api.sessions.promptStatus(request({ sessionId, requestId }))).result).toMatchObject({
      ok: false, error: { code: 'prompt-durability-unavailable' },
    })
    failedFlush.mockRestore()
    expect(expectValue(await api.sessions.promptStatus(request({ sessionId, requestId })))).toEqual({ state: 'accepted' })
    const path = ctx.sessionPersistence.locate(agent.session.header)!.path
    const bytes = await readFile(path)
    const receiptRow = bytes.indexOf('"agent/inbox/spliced"')
    expect(receiptRow).toBeGreaterThan(0)
    try {
      await writeFile(path, bytes.subarray(0, receiptRow + 4))
      expect((await api.sessions.promptStatus(request({ sessionId, requestId }))).result).toMatchObject({
        ok: false, error: { code: 'prompt-durability-unavailable' },
      })
    } finally { await writeFile(path, bytes) }
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
