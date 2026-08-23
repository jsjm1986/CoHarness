import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Governance from '../src/index.ts'

const PRIMARY_REF = credentialRef('DSH_ORG_PRIMARY_API_KEY')
const SECONDARY_REF = credentialRef('DSH_ORG_SECONDARY_API_KEY')
const oldHome = process.env.DSH_HOME

afterEach(() => {
  process.env.DSH_HOME = oldHome
  vi.restoreAllMocks()
})

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  constructor(ctx: Context, seed: Record<string, string>) {
    super(ctx)
    for (const [ref, value] of Object.entries(seed)) this.values.set(credentialRef(ref), value)
  }

  protected override resolveOwned(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  protected override describeOwned(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'memory' } : {}, writable: true })
  }

  protected override setOwned(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  protected override unsetOwned(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(key, next)
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

function policy(credentialRef: CredentialRef, version = 1): Record<string, unknown> {
  return {
    version,
    defaultAllowed: false,
    userDeclaredAllowed: true,
    models: [{ provider: 'org-primary', model: 'chat', allowed: true }],
    providers: [{
      provider: 'org-primary',
      displayName: 'Organization Primary',
      driver: 'pi-ai',
      protocol: 'openai-responses',
      baseURL: 'https://models.example.test/v1',
      credentialRef,
      models: [{ id: 'chat', name: 'Chat' }],
    }],
    intakeUrl: 'http://127.0.0.1:1/usage',
    intakeToken: 'token',
  }
}

function replacePolicy(home: string, body: Record<string, unknown>): void {
  const target = join(home, 'model-governance.json')
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify(body))
  renameSync(temporary, target)
}

async function boot(
  responseFor: (ref: string) => Response | Promise<Response>,
): Promise<{ ctx: Context; governance: Awaited<ReturnType<Context['plugin']>>; request: ReturnType<typeof vi.fn> }> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-organization-credentials-'))
  process.env.DSH_HOME = home
  writeFileSync(join(home, 'model-governance.json'), JSON.stringify(policy(PRIMARY_REF)))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemoryCredentials, {
    [PRIMARY_REF]: 'sk-personal-primary',
    [SECONDARY_REF]: 'sk-personal-secondary',
  })
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { ref: string }
    return responseFor(payload.ref)
  })
  ctx.provide('gatewayRuntime', { request } as unknown as GatewayRuntime)
  const governance = await ctx.plugin(Governance)
  return { ctx, governance, request }
}

describe('organization Provider credential layer', () => {
  it('keeps an unavailable managed reference from falling through to personal storage and rejects writes', async () => {
    const bench = await boot(() => Response.json({ configured: false }))

    expect(await bench.ctx.credentials.resolve(PRIMARY_REF)).toBeUndefined()
    expect(await bench.ctx.credentials.describe(PRIMARY_REF)).toEqual({ configured: false, writable: false })
    await expect(bench.ctx.credentials.set(PRIMARY_REF, 'sk-replacement')).rejects.toThrow(/read-only/)
    await expect(bench.ctx.credentials.unset(PRIMARY_REF)).rejects.toThrow(/read-only/)
    expect(bench.request).toHaveBeenCalledWith('/internal/runtime/model-credential', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ref: PRIMARY_REF }),
    }))

    await bench.governance.dispose()
    expect(await bench.ctx.credentials.resolve(PRIMARY_REF)).toEqual({
      value: 'sk-personal-primary',
      source: 'memory',
    })
    await bench.ctx.fiber.dispose()
  })

  it('returns organization credentials and follows the active Provider snapshot after reload', async () => {
    const bench = await boot(ref => Response.json({ configured: true, value: `sk-org-${ref}` }))

    expect(await bench.ctx.credentials.resolve(PRIMARY_REF)).toEqual({
      value: `sk-org-${PRIMARY_REF}`,
      source: 'organization',
    })
    replacePolicy(process.env.DSH_HOME!, policy(SECONDARY_REF, 2))
    await vi.waitFor(() => {
      expect(bench.ctx.modelProviderConfig.snapshot()).toMatchObject({
        revision: 2,
        providers: [{ credentialRef: SECONDARY_REF }],
      })
    })
    expect(await bench.ctx.credentials.resolve(PRIMARY_REF)).toEqual({
      value: 'sk-personal-primary',
      source: 'memory',
    })
    expect(await bench.ctx.credentials.resolve(SECONDARY_REF)).toEqual({
      value: `sk-org-${SECONDARY_REF}`,
      source: 'organization',
    })
    await bench.ctx.fiber.dispose()
  })

  it('propagates Gateway failures without using a personal value for the claimed reference', async () => {
    const bench = await boot(() => new Response('{}', { status: 503 }))

    await expect(bench.ctx.credentials.resolve(PRIMARY_REF)).rejects.toThrow(/HTTP 503/)
    await bench.ctx.fiber.dispose()
  })
})
