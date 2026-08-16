/** User-declared (BYOK) route authorization over the settings user layer. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import * as Governance from '../src/index.ts'

const oldHome = process.env.DSH_HOME
afterEach(() => { process.env.DSH_HOME = oldHome })

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, doc: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc)
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

class Adapter extends LlmAdapter {
  calls = 0
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 }, credentialSource: 'file' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []; for await (const chunk of source) result.push(chunk); return result
}

function writePolicy(home: string, body: Record<string, unknown>): void {
  writeFileSync(join(home, 'model-governance.json'), JSON.stringify({
    version: 1,
    defaultAllowed: false,
    userDeclaredAllowed: false,
    models: [],
    intakeUrl: 'http://127.0.0.1:1/usage',
    intakeToken: 'token',
    ...body,
  }))
}

interface Bench {
  ctx: Context
  adapter: Adapter
  home: string
}

/**
 * Boot one governed instance over two directory routes: `own` carries a
 * user-layer profile (settingsPath under `providers`), `shipped` has none, and
 * `company` is additionally listed in the policy catalog. The schema accepts
 * any provider profile shape; the decision under test reads layer presence,
 * not field values.
 */
async function boot(options: {
  userDeclaredAllowed: boolean
  catalog?: Array<{ provider: string; model: string; allowed: boolean }>
  userLayers?: Record<string, unknown>
}): Promise<Bench> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-byok-'))
  process.env.DSH_HOME = home
  writePolicy(home, {
    userDeclaredAllowed: options.userDeclaredAllowed,
    ...options.catalog === undefined ? {} : { models: options.catalog },
  })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['own', 'shipped', 'company'], adapter)
  await ctx.plugin(MemorySettings, {
    'llm-pi-ai': { providers: { own: {} }, ...options.userLayers === undefined ? {} : options.userLayers },
  })
  // Register a namespace matching the directory entries below so describe()
  // returns the user layer the governance plugin reads.
  await ctx.plugin({
    inject: ['settings'],
    apply: (sctx: Context) => {
      sctx.settings.register(settingsNamespace('llm-pi-ai'), z.object({}) as never, {
        base: { providers: { company: {} } },
      })
    },
  })
  await ctx.plugin(Governance)
  ctx.llm.registerConfigurableProviders([
    { provider: 'own', displayName: 'Own', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'own'] },
    { provider: 'shipped', displayName: 'Shipped', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'shipped'] },
    { provider: 'company', displayName: 'Company', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'company'] },
  ])
  return { ctx, adapter, home }
}

describe('user-declared route authorization', () => {
  it('authorizes an unlisted route the user layer declares', async () => {
    const bench = await boot({ userDeclaredAllowed: true })
    const chunks = await drain(bench.ctx.llm.stream({ provider: 'own', model: 'm1', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(bench.adapter.calls).toBe(1)
    await bench.ctx.fiber.dispose()
  })

  it('denies an unlisted route the user layer does not declare', async () => {
    const bench = await boot({ userDeclaredAllowed: true })
    const chunks = await drain(bench.ctx.llm.stream({ provider: 'shipped', model: 'm2', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    expect(bench.adapter.calls).toBe(0)
    await bench.ctx.fiber.dispose()
  })

  it('lets a catalog denial override the user-layer declaration', async () => {
    const bench = await boot({
      userDeclaredAllowed: true,
      catalog: [{ provider: 'own', model: 'm1', allowed: false }],
    })
    const chunks = await drain(bench.ctx.llm.stream({ provider: 'own', model: 'm1', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    expect(bench.adapter.calls).toBe(0)
    await bench.ctx.fiber.dispose()
  })

  it('keeps a composition-declared route unauthorized without a catalog entry', async () => {
    const bench = await boot({ userDeclaredAllowed: true })
    const chunks = await drain(bench.ctx.llm.stream({ provider: 'company', model: 'm3', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    expect(bench.adapter.calls).toBe(0)
    await bench.ctx.fiber.dispose()
  })

  it('denies user-declared routes when the policy disables them', async () => {
    const bench = await boot({ userDeclaredAllowed: false })
    const chunks = await drain(bench.ctx.llm.stream({ provider: 'own', model: 'm1', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    expect(bench.adapter.calls).toBe(0)
    await bench.ctx.fiber.dispose()
  })

  it('admits a route when the user layer declares it after boot', async () => {
    const bench = await boot({ userDeclaredAllowed: true })
    const denied = await drain(bench.ctx.llm.stream({ provider: 'shipped', model: 'm2', messages: [] }))
    expect(denied.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    await bench.ctx.settings.mutate(settingsNamespace('llm-pi-ai'), [{ op: 'set', path: ['providers', 'shipped'], value: {} }])
    await vi.waitFor(async () => {
      const chunks = await drain(bench.ctx.llm.stream({ provider: 'shipped', model: 'm2', messages: [] }))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    })
    await bench.ctx.fiber.dispose()
  })

  it('fails closed on an invalid live policy together with user-declared routes', async () => {
    const bench = await boot({ userDeclaredAllowed: true })
    const access = bench.ctx.get('modelAccess')
    if (access === undefined) throw new Error('model access service missing')
    // Wait for the unavailable state after the invalid file lands.
    writeFileSync(join(bench.home, 'model-governance.json'), '{}')
    await vi.waitFor(() => {
      expect(access.decide({ provider: 'own', model: 'm1' })).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('temporarily unavailable'),
      })
    })
    const chunks = await drain(bench.ctx.llm.stream({ provider: 'own', model: 'm1', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'MODEL_FORBIDDEN' } } })
    expect(bench.adapter.calls).toBe(0)
    await bench.ctx.fiber.dispose()
  })
})
