import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { inspect } from 'node:util'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayPrincipalClaims, GatewayRuntimeCredential } from '../src/index.ts'
import { recordModelResourceFinish } from '../src/model-tail-timing.ts'
import GatewayRuntime, {
  GatewayResponseTooLargeError,
  GATEWAY_PRINCIPAL_HEADER,
  GATEWAY_READINESS_NONCE_HEADER,
  GATEWAY_READINESS_PATH,
  GATEWAY_READINESS_REQUEST_HEADER,
  GatewaySessionCreationAuthorization,
  readGatewayResponseBytes,
  readGatewayResponseJson,
  parseGatewayRuntimeCredential,
  readGatewayRuntimeCredential,
  verifyGatewayPrincipal,
} from '../src/index.ts'

const NOW = Date.now()

function fixture(): {
  credential: GatewayRuntimeCredential
  issue: (claims?: Partial<GatewayPrincipalClaims>) => string
} {
  const pair = generateKeyPairSync('ed25519')
  const credential: GatewayRuntimeCredential = {
    version: 1,
    gatewayUrl: 'http://127.0.0.1:8899',
    organization: 'acme',
    runtime: { kind: 'project', id: 41, generation: 7 },
    token: 'runtime-secret',
    principalPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }
  const issue = (overrides: Partial<GatewayPrincipalClaims> = {}): string => {
    const claims: GatewayPrincipalClaims = {
      version: 1,
      issuer: 'harness-gateway',
      audience: 'dsh-runtime',
      organization: 'acme',
      user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
      scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
      runtime: { kind: 'project', id: 41, generation: 7 },
      issuedAt: NOW,
      expiresAt: NOW + 30_000,
      nonce: 'nonce-1',
      ...overrides,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
  }
  return { credential, issue }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
  delete process.env.DSH_GATEWAY_CREDENTIAL_FD
})

describe('Gateway runtime credential', () => {
  it.each(['http://127.0.0.1:8899', 'http://localhost:8899', 'http://[::1]:8899'])('accepts the loopback origin %s', (gatewayUrl) => {
    const { credential } = fixture()
    expect(parseGatewayRuntimeCredential({ ...credential, gatewayUrl }).gatewayUrl).toBe(gatewayUrl)
  })

  it.each([
    'http://example.com:8899', 'http://[2001:db8::1]:8899', 'http://[::]:8899',
    'https://[::1]:8899', 'http://[::1]:8899/private', 'http://[::1]:8899/?scope=other',
    'http://user:synthetic-password@[::1]:8899',
  ])('refuses the non-origin or non-loopback credential URL %s', (gatewayUrl) => {
    const { credential } = fixture()
    expect(() => parseGatewayRuntimeCredential({ ...credential, gatewayUrl })).toThrow('loopback HTTP origin')
  })

  it('retains the channel read failure without misreporting it as invalid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-credential-read-error-'))
    try {
      const channel = { DSH_GATEWAY_CREDENTIAL_FILE: join(root, 'missing.json') }
      expect(() => readGatewayRuntimeCredential(channel)).toThrow(/ENOENT/u)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('omits malformed origin bytes from credential diagnostics', () => {
    const { credential } = fixture(), marker = 'private-synthetic-origin'
    let failure: unknown
    try { parseGatewayRuntimeCredential({ ...credential, gatewayUrl: marker }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(inspect(failure, { depth: 8 })).not.toContain(marker)
  })

  it('accepts only a loopback HTTP origin and a positive runtime identity', () => {
    const { credential } = fixture()
    expect(parseGatewayRuntimeCredential(credential)).toEqual(credential)
    expect(() => parseGatewayRuntimeCredential({ ...credential, gatewayUrl: 'https://127.0.0.1:8899' }))
      .toThrow(/loopback HTTP origin/)
    expect(() => parseGatewayRuntimeCredential({
      ...credential,
      runtime: { ...credential.runtime, generation: 0 },
    })).toThrow(/invalid Gateway runtime credential/)
  })

  it('validates optional private renewal pacing at the launch credential parser', () => {
    const { credential } = fixture()
    const renewal = { enabled: true, intervalMs: 10_000, requestTimeoutMs: 5000, maxBatchSize: 64 }
    expect(parseGatewayRuntimeCredential({ ...credential, streamPrincipalRenewal: renewal }).streamPrincipalRenewal).toEqual(renewal)
    for (const invalid of [null, {}, { ...renewal, enabled: false }, { ...renewal, intervalMs: 0 },
      { ...renewal, requestTimeoutMs: 2_147_483_648 }, { ...renewal, maxBatchSize: 1025 }, { ...renewal, maxBatchSize: 1.5 }]) {
      expect(() => parseGatewayRuntimeCredential({ ...credential, streamPrincipalRenewal: invalid })).toThrow('renewal configuration')
    }
  })

  it('rejects tampering, expiry, and a foreign runtime generation', () => {
    const { credential, issue } = fixture()
    const assertion = issue()
    const tampered = `${assertion.slice(0, -1)}${assertion.endsWith('A') ? 'B' : 'A'}`
    expect(verifyGatewayPrincipal(assertion, credential, undefined, NOW + 1).user.id).toBe(9)
    expect(() => verifyGatewayPrincipal(tampered, credential, undefined, NOW + 1))
      .toThrow(/invalid Gateway principal assertion/)
    expect(() => verifyGatewayPrincipal(assertion, credential, undefined, NOW + 30_000))
      .toThrow(/expired or foreign/)
    expect(() => verifyGatewayPrincipal(issue({
      runtime: { kind: 'project', id: 41, generation: 8 },
    }), credential, undefined, NOW + 1)).toThrow(/expired or foreign/)
  })

  it('binds the signed principal to the allocated RuntimeId even when owner and generation match', () => {
    const { credential, issue } = fixture()
    const runtimeId = '11111111-1111-4111-8111-111111111111' as NonNullable<GatewayRuntimeCredential['runtime']['runtimeId']>
    const otherId = '22222222-2222-4222-8222-222222222222' as typeof runtimeId
    const selected = { ...credential, runtime: { ...credential.runtime, runtimeId } }
    expect(parseGatewayRuntimeCredential(selected).runtime.runtimeId).toBe(runtimeId)
    expect(verifyGatewayPrincipal(issue({ runtime: selected.runtime }), selected, undefined, NOW + 1).runtime.runtimeId).toBe(runtimeId)
    expect(() => verifyGatewayPrincipal(
      issue({ runtime: { ...selected.runtime, runtimeId: otherId } }), selected, undefined, NOW + 1,
    )).toThrow(/foreign/)
    expect(() => verifyGatewayPrincipal(issue(), selected, undefined, NOW + 1)).toThrow(/foreign/)
    expect(() => verifyGatewayPrincipal(issue({ runtime: selected.runtime }), credential, undefined, NOW + 1)).toThrow(/foreign/)
    expect(() => parseGatewayRuntimeCredential({ ...selected, runtime: { ...selected.runtime, runtimeId: 'invalid' } })).toThrow(/invalid/)
  })

  it('retains a registered computer in the private launch credential', () => {
    const { credential } = fixture()
    const nodeId = '11111111-1111-4111-8111-111111111111'
    expect(parseGatewayRuntimeCredential({ ...credential, nodeId }).nodeId).toBe(nodeId)
    expect(() => parseGatewayRuntimeCredential({ ...credential, nodeId: 'another-computer' })).toThrow('invalid Gateway runtime credential')
  })

  it('accepts only the signed administrator archive capability for another personal runtime', () => {
    const { credential, issue } = fixture()
    const personalCredential: GatewayRuntimeCredential = {
      ...credential,
      runtime: { kind: 'user', id: 41, generation: 7 },
    }
    const archive = issue({
      user: { id: 9, username: 'admin', displayName: 'Admin', role: 'admin' },
      scope: { kind: 'personal' },
      runtime: { kind: 'user', id: 41, generation: 7 },
      purpose: 'archive-read',
    })
    expect(verifyGatewayPrincipal(archive, personalCredential).purpose).toBe('archive-read')
    const ordinary = issue({
      user: { id: 9, username: 'admin', displayName: 'Admin', role: 'admin' },
      scope: { kind: 'personal' },
      runtime: { kind: 'user', id: 41, generation: 7 },
    })
    expect(() => verifyGatewayPrincipal(ordinary, personalCredential)).toThrow(/scope/)
  })
})

describe('Gateway request context', () => {
  it('writes enabled model phase measurements to the managed process log', async () => {
    const { credential } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-model-timings-'))
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = new Context()
    try {
      const credentialPath = join(root, 'credential.json')
      await writeFile(credentialPath, JSON.stringify(credential))
      process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
      ctx.provide('connection', {} as never)
      await ctx.plugin(GatewayRuntime, { modelTimings: true }).await()
      const sample = {
        startedAt: 1000, outcome: 'first-text', elapsedMs: 29,
        adapterPreparationMs: 1, resourceWaitMs: 3, initialAuthorizationMs: 2,
        adapterDispatchPreparationMs: 4, dispatchAuthorizationMs: 5, adapterCallbacks: 1,
        afterLastAuthorizationMs: 14,
      } as const
      ctx.emit('llm/model-attempt-timing', sample)
      expect(output).toHaveBeenCalledTimes(1)
      const prefix = '[model-attempt-timing] '
      const line = String(output.mock.calls[0]?.[0])
      expect(line.startsWith(prefix)).toBe(true)
      expect(JSON.parse(line.slice(prefix.length))).toEqual(sample)
      const correlated = { ...sample, resourceOperationId: '00000000-0000-4000-8000-000000000001' } as const
      ctx.emit('llm/model-attempt-timing', correlated)
      expect(output).toHaveBeenCalledTimes(2)
      expect(JSON.parse(String(output.mock.calls[1]?.[0]).slice(prefix.length))).toEqual(correlated)

      const session = { id: SessionId('tail-session') } as never
      const opId = '00000000-0000-4000-8000-000000000002' as ResourceOperationId
      const opId2 = '00000000-0000-4000-8000-000000000003' as ResourceOperationId
      const retryOpId = '00000000-0000-4000-8000-000000000099' as ResourceOperationId
      // No-op when target has no attached recorder (e.g. modelTimings disabled).
      recordModelResourceFinish({}, {
        sessionId: SessionId('tail-session'), operationId: opId, outcome: 'quiescent',
        acknowledged: true, retry: false, startedAt: 1000, finishedPerf: performance.now(), elapsedMs: 1.0,
      })
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } } as never)
      recordModelResourceFinish(ctx.gatewayRuntime, {
        sessionId: SessionId('tail-session'), operationId: opId, outcome: 'quiescent',
        acknowledged: true, retry: false, startedAt: 1000, finishedPerf: performance.now(), elapsedMs: 12.34,
      })
      ctx.emit('session/event', session, { type: 'turn/start', seq: SessionSeq(2), time: 2, data: { turn: 1 } } as never)
      ctx.emit('session/event', session, { type: 'user/message', seq: SessionSeq(2), time: 2, data: {} } as never)
      ctx.emit('session/event', session, { type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } } as never)
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 0 } } as never)
      // Same-step retry (assistant/attempt -> assistant/message on step 1) keeps stepCount at 1.
      ctx.emit('session/event', session, { type: 'assistant/attempt', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } } as never)
      recordModelResourceFinish(ctx.gatewayRuntime, {
        sessionId: SessionId('tail-session'), operationId: opId, outcome: 'quiescent',
        acknowledged: true, retry: false, startedAt: 1000, finishedPerf: performance.now(), elapsedMs: 12.34,
      })
      // A deferred background retry from an earlier turn cannot overwrite the active turn's finish correlation.
      recordModelResourceFinish(ctx.gatewayRuntime, {
        sessionId: SessionId('tail-session'), operationId: retryOpId, outcome: 'quiescent',
        acknowledged: true, retry: true, startedAt: 900, finishedPerf: performance.now(), elapsedMs: 5.5,
      })
      ctx.emit('session/event', session, { type: 'assistant/message', seq: SessionSeq(3), time: 3, data: { turn: 1, step: 1 } } as never)
      // Mismatched step/end cannot close step 1; matching step/end closes step 1.
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(4), time: 4, data: { turn: 1, step: 99 } } as never)
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(4), time: 4, data: { turn: 1, step: 1 } } as never)
      ctx.emit('session/event', session, { type: 'turn/end', seq: SessionSeq(5), time: 5, data: { turn: 1, reason: { kind: 'completed' } } } as never)
      const tailPrefix = '[model-turn-tail-timing] '
      const tailLine = String(output.mock.calls.at(-1)?.[0])
      expect(tailLine.startsWith(tailPrefix)).toBe(true)
      const tail = JSON.parse(tailLine.slice(tailPrefix.length)) as Record<string, unknown>
      expect(tail).toMatchObject({
        turn: 1, reason: 'completed', assistantEventType: 'assistant/message', assistantSeq: 3, step: 1,
        resourceOperationId: opId, resourceFinishOutcome: 'quiescent', resourceFinishAcknowledged: true,
        resourceFinishElapsedMs: 12.34,
      })
      expect(tail.stepCount).toBeUndefined()
      for (const key of ['resourceFinishToAssistantMs', 'assistantToStepEndMs', 'stepEndToTurnEndMs', 'assistantToTurnEndMs', 'resourceFinishToTurnEndMs']) {
        expect(typeof tail[key]).toBe('number')
      }

      // Exercise multi-step turn recording (>16 step cap and steps without finish).
      ctx.emit('session/event', session, { type: 'turn/start', seq: SessionSeq(10), time: 10, data: { turn: 3 } } as never)
      ctx.emit('session/event', session, { type: 'step/start', seq: SessionSeq(10), time: 10, data: { turn: 3, step: 1 } } as never)
      recordModelResourceFinish(ctx.gatewayRuntime, {
        sessionId: SessionId('tail-session'), operationId: opId, outcome: 'quiescent',
        acknowledged: true, retry: false, startedAt: 1010, finishedPerf: performance.now(), elapsedMs: 3.2,
      })
      ctx.emit('session/event', session, { type: 'assistant/message', seq: SessionSeq(11), time: 11, data: { turn: 3, step: 1 } } as never)
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(12), time: 12, data: { turn: 3, step: 1 } } as never)
      for (let step = 2; step <= 18; step++) {
        ctx.emit('session/event', session, { type: 'step/start', seq: SessionSeq(9 + step * 2), time: 9 + step, data: { turn: 3, step } } as never)
        if (step === 2) {
          recordModelResourceFinish(ctx.gatewayRuntime, {
            sessionId: SessionId('tail-session'), operationId: opId2, outcome: 'quiescent',
            acknowledged: true, retry: false, startedAt: 1015, finishedPerf: performance.now(), elapsedMs: 4.1,
          })
        }
        ctx.emit('session/event', session, {
          type: 'assistant/message',
          seq: SessionSeq(10 + step * 2),
          time: 10 + step,
          data: { turn: 3, step },
        } as never)
        ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(11 + step * 2), time: 11 + step, data: { turn: 3, step } } as never)
      }
      ctx.emit('session/event', session, { type: 'turn/end', seq: SessionSeq(99), time: 99, data: { turn: 3, reason: { kind: 'completed' } } } as never)
      const multiStep = JSON.parse(String(output.mock.calls.at(-1)?.[0]).slice(tailPrefix.length)) as Record<string, unknown>
      expect(multiStep).toMatchObject({ turn: 3, stepCount: 18, reason: 'completed' })
      expect(Array.isArray(multiStep.steps)).toBe(true)
      expect((multiStep.steps as unknown[]).length).toBe(16)

      // Step 2 aborting before assistant/message must not duplicate Step 1 in steps.
      ctx.emit('session/event', session, { type: 'turn/start', seq: SessionSeq(100), time: 100, data: { turn: 4 } } as never)
      ctx.emit('session/event', session, { type: 'step/start', seq: SessionSeq(101), time: 101, data: { turn: 4, step: 1 } } as never)
      ctx.emit('session/event', session, { type: 'assistant/message', seq: SessionSeq(102), time: 102, data: { turn: 4, step: 1 } } as never)
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(103), time: 103, data: { turn: 4, step: 1 } } as never)
      ctx.emit('session/event', session, { type: 'step/start', seq: SessionSeq(104), time: 104, data: { turn: 4, step: 2 } } as never)
      ctx.emit('session/event', session, { type: 'step/end', seq: SessionSeq(105), time: 105, data: { turn: 4, step: 2 } } as never)
      ctx.emit('session/event', session, { type: 'turn/end', seq: SessionSeq(106), time: 106, data: { turn: 4, reason: { kind: 'aborted' } } } as never)
      const abortedStep2 = JSON.parse(String(output.mock.calls.at(-1)?.[0]).slice(tailPrefix.length)) as Record<string, unknown>
      expect(abortedStep2).toMatchObject({ turn: 4, reason: 'aborted' })
      expect(abortedStep2.assistantEventType).toBeUndefined()
      expect(abortedStep2.steps).toBeUndefined()

      // Exercise turn/end without assistant/step, session/disposed, bounded session eviction, and error containment.
      ctx.emit('session/event', session, { type: 'turn/start', seq: SessionSeq(6), time: 6, data: { turn: 2 } } as never)
      recordModelResourceFinish(ctx.gatewayRuntime, {
        sessionId: SessionId('tail-session'), operationId: opId, outcome: 'not-started',
        acknowledged: true, retry: false, startedAt: 1001, finishedPerf: performance.now(), elapsedMs: 1.5,
      })
      ctx.emit('session/event', session, { type: 'turn/end', seq: SessionSeq(7), time: 7, data: { turn: 2, reason: { kind: 'aborted' } } } as never)
      const emptyTurnLine = String(output.mock.calls.at(-1)?.[0])
      expect(JSON.parse(emptyTurnLine.slice(tailPrefix.length))).toMatchObject({
        turn: 2, reason: 'aborted', resourceOperationId: opId, resourceFinishOutcome: 'not-started',
      })

      const disposed = { id: SessionId('disposed-session') } as never
      ctx.emit('session/event', disposed, { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } as never)
      ctx.emit('session/disposed', disposed)
      ctx.emit('session/event', disposed, { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as never)

      for (let i = 0; i <= 1025; i++) {
        ctx.emit('session/event', { id: SessionId(`evict-${i}`) } as never, { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } as never)
      }
      const tailLines = () => output.mock.calls.filter(([line]) => String(line).startsWith(tailPrefix)).length
      const beforeEvicted = tailLines()
      ctx.emit('session/event', { id: SessionId('evict-0') } as never, { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as never)
      expect(tailLines()).toBe(beforeEvicted)
      ctx.emit('session/event', { id: SessionId('evict-1025') } as never, { type: 'assistant/attempt', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } } as never)
      ctx.emit('session/event', { id: SessionId('evict-1025') } as never, { type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'error' } } } as never)
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]).slice(tailPrefix.length))).toMatchObject({
        turn: 1, reason: 'error', assistantEventType: 'assistant/attempt', assistantSeq: 2,
      })

      output.mockImplementationOnce(() => { throw new Error('sink failed') })
      ctx.emit('session/event', { id: SessionId('evict-1024') } as never, { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as never)
    } finally {
      output.mockRestore()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits [runtime-boot-timing] once on the first authenticated readiness 200 with startup marks and 503 counts', async () => {
    const { credential } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-boot-timings-'))
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = new Context()
    let readinessHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
    try {
      const credentialPath = join(root, 'credential.json')
      await writeFile(credentialPath, JSON.stringify(credential))
      process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
      const startupMarks: {
        entryUptimeMs: number
        proxyInstalledMs: number
        profileComposedMs: number
        patchesReadMs: number
        hostPreparedMs: number
        bootSettledMs?: number
        notifySettled?: () => void
      } = {
        entryUptimeMs: 120, proxyInstalledMs: 10, profileComposedMs: 25,
        patchesReadMs: 30, hostPreparedMs: 45,
      }
      ctx.provide('runtimeStartupMarks', startupMarks)
      ctx.provide('connection', {
        http: {
          handlePrefix: (_path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => {
            readinessHandler = handler
            return async () => {}
          },
        },
      } as never)
      await ctx.plugin(GatewayRuntime, { modelTimings: true, requiredPlugins: ['req-a'] }).await()
      const probe = async () => {
        const nonce = 'nonce-12345678901234567890'
        const proof = createHmac('sha256', credential.token)
          .update(`dsh-gateway-readiness-v1\u0000request\u0000${nonce}\u0000${credential.runtime.kind}\u0000${credential.runtime.id}\u0000${credential.runtime.generation}`)
          .digest('base64url')
        let status = 0
        const res = Object.assign({} as ServerResponse, {
          writeHead(code: number) { status = code; return res },
          end() { return res },
        })
        await ctx.waterfall('connection/request', {
          kind: 'http', method: 'GET', pathname: GATEWAY_READINESS_PATH,
          headers: { [GATEWAY_READINESS_NONCE_HEADER]: nonce, [GATEWAY_READINESS_REQUEST_HEADER]: proof },
        }, async () => {
          readinessHandler?.({} as IncomingMessage, res)
        })
        return status
      }
      expect(await probe()).toBe(503)
      ctx.provide('resourceBudget', {} as never)
      expect(await probe()).toBe(503)
      ctx.provide('loader', {
        entries: () => [{ options: { id: 'req-a' }, fiber: { state: FiberState.ACTIVE } }],
      } as never)
      expect(await probe()).toBe(200)
      expect(await probe()).toBe(200)
      const bootLines = output.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('[runtime-boot-timing] '))
      expect(bootLines).toHaveLength(1)
      const bootSample = JSON.parse((bootLines[0] ?? '').slice('[runtime-boot-timing] '.length)) as Record<string, unknown>
      expect(bootSample).toMatchObject({
        kind: 'project', ownerId: 41, generation: 7,
        readiness503ResourceBudget: 1, readiness503RequiredPlugins: 1, pluginCount: 1,
        profileBoot: {
          entryUptimeMs: 120, proxyInstalledMs: 10, profileComposedMs: 25,
          patchesReadMs: 30, hostPreparedMs: 45,
        },
      })
      for (const key of ['credentialReadStartUptimeMs', 'credentialReadMs', 'gatewayRuntimeReadyUptimeMs', 'firstReadinessUptimeMs']) {
        expect(typeof bootSample[key]).toBe('number')
      }
      expect(typeof startupMarks.notifySettled).toBe('function')
      startupMarks.bootSettledMs = 95
      startupMarks.notifySettled?.()
      expect(startupMarks.notifySettled).toBeUndefined()
      const settledLines = output.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('[runtime-boot-settled] '))
      expect(settledLines).toHaveLength(1)
      const settled = JSON.parse((settledLines[0] ?? '').slice('[runtime-boot-settled] '.length)) as Record<string, unknown>
      expect(settled).toMatchObject({ kind: 'project', ownerId: 41, generation: 7, bootSettledMs: 95, pluginCount: 1 })
      expect(typeof settled.bootSettledUptimeMs).toBe('number')
      await ctx.fiber.dispose()
      expect(startupMarks.notifySettled).toBeUndefined()

      // An in-flight readiness probe running after fiber transitions to UNLOADING must never leak notifySettled onto ctx.root.
      const unloadingCtx = new Context()
      const unloadingMarks: typeof startupMarks = {
        entryUptimeMs: 120, proxyInstalledMs: 10, profileComposedMs: 25, patchesReadMs: 30, hostPreparedMs: 45,
      }
      unloadingCtx.provide('runtimeStartupMarks', unloadingMarks)
      unloadingCtx.provide('resourceBudget', {} as never)
      unloadingCtx.provide('loader', {
        entries: () => [{ options: { id: 'req-a' }, fiber: { state: FiberState.ACTIVE } }],
      } as never)
      let unloadingHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
      unloadingCtx.provide('connection', {
        http: {
          handlePrefix: (_path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => {
            unloadingHandler = handler
            return async () => {}
          },
        },
      } as never)
      const fiber = unloadingCtx.plugin(GatewayRuntime, { modelTimings: true, requiredPlugins: ['req-a'] })
      await fiber.await()
      const nonce = 'nonce-unloading-1234567890'
      const proof = createHmac('sha256', credential.token)
        .update(`dsh-gateway-readiness-v1\u0000request\u0000${nonce}\u0000${credential.runtime.kind}\u0000${credential.runtime.id}\u0000${credential.runtime.generation}`)
        .digest('base64url')
      const res = Object.assign({} as ServerResponse, { writeHead() { return res }, end() { return res } })
      await unloadingCtx.waterfall('connection/request', {
        kind: 'http', method: 'GET', pathname: GATEWAY_READINESS_PATH,
        headers: { [GATEWAY_READINESS_NONCE_HEADER]: nonce, [GATEWAY_READINESS_REQUEST_HEADER]: proof },
      }, async () => {
        const disposing = fiber.dispose()
        unloadingHandler?.({} as IncomingMessage, res)
        await disposing
      })
      expect(unloadingMarks.notifySettled).toBeUndefined()
      await unloadingCtx.fiber.dispose()
    } finally {
      output.mockRestore()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates concurrent principals and forwards only the selected assertion', async () => {
    const { credential, issue } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    const credentialPath = join(root, 'credential.json')
    await writeFile(credentialPath, JSON.stringify(credential))
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    const fiber = ctx.plugin(GatewayRuntime)
    await fiber.await()
    expect(ctx.gatewayRuntime.identity).toEqual(credential.runtime)
    expect(ctx.gatewayRuntime.organization).toBe('acme')
    expect(ctx.get('executionAuthorityRequired')).toBe(true)
    expect(ctx.get('modelAccessRequired')).toBe(true)
    expect(ctx.get('collaborationRequired')).toBe(true)

    const sessionId = SessionId('pending-root')
    const authorization = Promise.resolve(GatewaySessionCreationAuthorization('creation-authorization'))
    const unregister = ctx.gatewayRuntime.registerSessionCreation(sessionId, authorization)
    expect(ctx.gatewayRuntime.sessionCreation(sessionId)).toBe(authorization)
    expect(() => ctx.gatewayRuntime.registerSessionCreation(
      sessionId,
      Promise.resolve(GatewaySessionCreationAuthorization('other-authorization')),
    )).toThrow(/already has a pending Gateway creation authorization/)
    unregister()
    unregister()
    expect(ctx.gatewayRuntime.sessionCreation(sessionId)).toBeUndefined()
    expect(() => GatewaySessionCreationAuthorization('')).toThrow(/must not be empty/)

    const seen: Array<{ url: string; authorization: string | null; principal: string | null }> = []
    vi.stubGlobal('fetch', vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        authorization: headers.get('authorization'),
        principal: headers.get(GATEWAY_PRINCIPAL_HEADER),
      })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))

    const first = issue({
      user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
      nonce: 'first',
    })
    const second = issue({
      user: { id: 10, username: 'mei', displayName: 'Mei', role: 'admin' },
      nonce: 'second',
    })
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstEntered!: () => void
    const entered = new Promise<void>((resolve) => { firstEntered = resolve })
    const run = (assertion: string, operation: () => Promise<void>): Promise<void> =>
      ctx.waterfall('connection/request', {
        kind: 'http', headers: { [GATEWAY_PRINCIPAL_HEADER]: assertion },
      }, operation)

    const detachedRelease = Promise.withResolvers<undefined>()
    let detached: Promise<void> | undefined
    const firstRun = run(first, async () => {
      expect(ctx.gatewayRuntime.interactive()?.claims.user.id).toBe(9)
      detached = detachedRelease.promise.then(() => {
        expect(ctx.gatewayRuntime.current()?.claims.user.id).toBe(9)
        expect(ctx.gatewayRuntime.interactive()).toBeUndefined()
      })
      expect(ctx.gatewayRuntime.requireCurrent().claims.user.id).toBe(9)
      firstEntered()
      await blocked
      expect(ctx.gatewayRuntime.requireCurrent().claims.user.id).toBe(9)
      await ctx.gatewayRuntime.request('/internal/runtime/session/list', { principal: true })
    })
    await entered
    await run(second, async () => {
      expect(ctx.gatewayRuntime.requireCurrent().claims.user.id).toBe(10)
      await ctx.gatewayRuntime.request('/internal/runtime/session/list', { principal: true })
    })
    releaseFirst()
    await firstRun
    detachedRelease.resolve(undefined)
    await detached
    await ctx.gatewayRuntime.request('/internal/runtime/session/list')

    expect(seen).toEqual([
      {
        url: 'http://127.0.0.1:8899/internal/runtime/session/list',
        authorization: 'Bearer runtime-secret',
        principal: second,
      },
      {
        url: 'http://127.0.0.1:8899/internal/runtime/session/list',
        authorization: 'Bearer runtime-secret',
        principal: first,
      },
      {
        url: 'http://127.0.0.1:8899/internal/runtime/session/list',
        authorization: 'Bearer runtime-secret',
        principal: null,
      },
    ])
    expect(ctx.gatewayRuntime.current()).toBeUndefined()
    await fiber.dispose()
    expect(ctx.get('executionAuthorityRequired')).toBe(true)
    expect(ctx.get('modelAccessRequired')).toBe(true)
    expect(ctx.get('collaborationRequired')).toBe(true)
    const replacement = ctx.plugin(GatewayRuntime)
    await replacement.await()
    expect(ctx.get('collaborationRequired')).toBe(true)
    await replacement.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects alternate origins, fragments, traversal, and encoded dot segments', async () => {
    const { credential } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    const credentialPath = join(root, 'credential.json')
    await writeFile(credentialPath, JSON.stringify(credential))
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    const fiber = ctx.plugin(GatewayRuntime)
    await fiber.await()
    const fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetch)

    for (const path of [
      '//127.0.0.1:8899/internal/runtime/session/list',
      '//example.test/internal/runtime/session/list',
      '/internal/runtime/session/list#secret',
      '/internal/runtime/../admin',
      '/internal/runtime/%2e%2e/admin',
      '/internal/runtime/%252e%252e/admin',
    ]) {
      expect(() => ctx.gatewayRuntime.request(path)).toThrow(/invalid Gateway runtime API path/)
    }
    expect(fetch).not.toHaveBeenCalled()
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a request without a Gateway principal before downstream dispatch', async () => {
    const { credential } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-'))
    const credentialPath = join(root, 'credential.json')
    await writeFile(credentialPath, JSON.stringify(credential))
    process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    const fiber = ctx.plugin(GatewayRuntime)
    await fiber.await()
    let reached = false
    await expect(Promise.resolve().then(() =>
      ctx.waterfall('connection/request', { kind: 'upgrade', headers: {} }, async () => {
        reached = true
      }))).rejects.toThrow(/principal assertion is required/)
    expect(reached).toBe(false)
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
})

describe('bounded Gateway responses', () => {
  it.each(['declared-overflow', 'streamed-overflow', 'between-chunks'] as const)(
    'ends a %s response read before pending body cancellation is acknowledged', async (mode) => {
      const cleanup = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
      const cancellation = new AbortController(), reason = new Error('response deadline')
      let delivered = false, settled = false, failure: unknown
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode !== 'between-chunks') controller.enqueue(new Uint8Array(5))
        },
        pull(controller) {
          if (mode !== 'between-chunks' || delivered) return
          delivered = true
          controller.enqueue(new Uint8Array(1))
          queueMicrotask(() => { cancellation.abort(reason) })
        },
        cancel() { entered.resolve(undefined); return cleanup.promise },
      })
      const response = new Response(body, mode === 'declared-overflow' ? { headers: { 'content-length': '5' } } : undefined)
      const result = readGatewayResponseBytes(response, 4, cancellation.signal).then(
        () => { settled = true }, (error: unknown) => { settled = true; failure = error },
      )
      try {
        await entered.promise
        cancellation.abort(reason)
        await setImmediate()
        expect(settled).toBe(true)
        if (mode === 'between-chunks') expect(failure).toBe(reason)
        else expect(failure).toBeInstanceOf(GatewayResponseTooLargeError)
      } finally {
        cleanup.resolve(undefined)
        await result
      }
    },
  )

  it('cancels a pre-aborted response without waiting for body cleanup acknowledgement', async () => {
    const cleanup = Promise.withResolvers<undefined>(), reason = new Error('cancelled before reading')
    let cancelled = false, failure: unknown
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return cleanup.promise },
    })
    const result = readGatewayResponseBytes(new Response(body), 32, AbortSignal.abort(reason))
      .catch((error: unknown) => { failure = error })
    try {
      await setImmediate()
      expect(cancelled).toBe(true)
      expect(failure).toBe(reason)
    } finally {
      cleanup.resolve(undefined)
      await body.cancel()
      await result
    }
  })

  it.each(['declared-overflow', 'streamed-overflow', 'pending-signal'] as const)(
    'preserves the %s read error when body cancellation fails', async (mode) => {
      const cancellation = new AbortController(), reason = new Error('response consumer closed')
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode !== 'pending-signal') controller.enqueue(new Uint8Array(5))
        },
        cancel() { cancelled = true; throw new Error('body cleanup failed') },
      })
      const response = new Response(body, mode === 'declared-overflow' ? { headers: { 'content-length': '5' } } : undefined)
      const result = readGatewayResponseBytes(response, 4, cancellation.signal)
      const rejected = mode === 'pending-signal'
        ? expect(result).rejects.toBe(reason)
        : expect(result).rejects.toBeInstanceOf(GatewayResponseTooLargeError)
      if (mode === 'pending-signal') cancellation.abort(reason)
      await rejected
      expect(cancelled).toBe(true)
      await setImmediate()
    },
  )

  it('reads and parses a chunked JSON response within its byte budget', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'))
        controller.enqueue(new TextEncoder().encode('true}'))
        controller.close()
      },
    }))
    await expect(readGatewayResponseJson(response, 32)).resolves.toEqual({ ok: true })
  })

  it('rejects a declared oversized response before parsing', async () => {
    const response = new Response('12345')
    await expect(readGatewayResponseBytes(response, 4)).rejects.toBeInstanceOf(GatewayResponseTooLargeError)
  })

  it('cancels a chunked response when the body crosses its budget', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
      },
      pull(controller) {
        controller.enqueue(new Uint8Array(3))
      },
      cancel() { cancelled = true },
    }))
    await expect(readGatewayResponseBytes(response, 4)).rejects.toBeInstanceOf(GatewayResponseTooLargeError)
    expect(cancelled).toBe(true)
  })

  it('rejects invalid response limits and malformed JSON', async () => {
    await expect(readGatewayResponseBytes(new Response('{}'), 0)).rejects.toThrow(/positive safe integer/)
    await expect(readGatewayResponseJson(new Response('not-json'), 32)).rejects.toThrow(SyntaxError)
  })

  it('cancels a pending response body read with the caller signal', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start() {},
      cancel() { cancelled = true },
    }))
    const controller = new AbortController()
    const pending = readGatewayResponseBytes(response, 32, controller.signal)
    const reason = new Error('response consumer closed')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(cancelled).toBe(true)
  })
})

it('answers connection/authenticate on Headers or Node records before any cookie exists', async () => {
  const { credential, issue } = fixture()
  const root = await mkdtemp(join(tmpdir(), 'gateway-authenticate-'))
  const credentialPath = join(root, 'credential.json')
  await writeFile(credentialPath, JSON.stringify(credential))
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
  const ctx = new Context()
  ctx.provide('connection', {} as never)
  await ctx.plugin(GatewayRuntime)
  const admin = { id: 9, username: 'admin', displayName: 'Admin', role: 'admin' as const }
  try {
    // A Fetch Headers instance and a Node record carry the assertion equally.
    expect(ctx.bail('connection/authenticate', {
      headers: new Headers([[GATEWAY_PRINCIPAL_HEADER, issue()]]),
      method: 'GET', url: '/', kind: 'index',
    })).toBe('allow')
    expect(ctx.bail('connection/authenticate', {
      headers: { [GATEWAY_PRINCIPAL_HEADER]: issue() },
      method: 'GET', url: '/api/events.mux', kind: 'upgrade',
    })).toBe('allow')
    // Absent, forged, and non-string headers all deny.
    expect(ctx.bail('connection/authenticate', {
      headers: new Headers(), kind: 'index',
    })).toBe('deny')
    expect(ctx.bail('connection/authenticate', {
      headers: { [GATEWAY_PRINCIPAL_HEADER]: 'forged' }, kind: 'http',
    })).toBe('deny')
    // A purpose assertion never admits the index or an upgrade carrier.
    const bounded = issue({ purpose: 'terminal-admin', user: admin })
    for (const kind of ['index', 'upgrade'] as const) {
      expect(ctx.bail('connection/authenticate', {
        headers: { [GATEWAY_PRINCIPAL_HEADER]: bounded }, kind,
      })).toBe('deny')
    }
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('confines signed terminal management to metadata and termination HTTP endpoints', async () => {
  const { credential, issue } = fixture()
  const root = await mkdtemp(join(tmpdir(), 'terminal-management-'))
  const personal = { ...credential, runtime: { kind: 'user' as const, id: 41, generation: 7 } }
  const credentialPath = join(root, 'credential.json')
  await writeFile(credentialPath, JSON.stringify(personal))
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
  const ctx = new Context()
  ctx.provide('connection', {} as never)
  await ctx.plugin(GatewayRuntime)
  const headers = { [GATEWAY_PRINCIPAL_HEADER]: issue({
    user: { id: 9, username: 'admin', displayName: 'Admin', role: 'admin' }, purpose: 'terminal-admin',
    runtime: personal.runtime, scope: { kind: 'personal' },
  }) }
  const called = vi.fn(async () => {})
  try {
    for (const method of ['adminList', 'adminClose']) {
      await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: `/api/terminal/${method}`, headers }, called)
    }
    expect(called).toHaveBeenCalledTimes(2)
    for (const request of [
      { kind: 'http' as const, method: 'POST', pathname: '/api/terminal/follow' },
      { kind: 'http' as const, method: 'GET', pathname: '/api/terminal/adminList' },
      { kind: 'upgrade' as const, pathname: '/api/terminal/adminList' },
    ]) {
      await expect(async () => ctx.waterfall('connection/request', { ...request, headers }, called)).rejects.toThrow('only inventory and termination')
    }
    expect(called).toHaveBeenCalledTimes(2)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('limits cross-user plugin administration to declared profile methods', async () => {
  const { credential, issue } = fixture()
  const root = await mkdtemp(join(tmpdir(), 'plugin-management-'))
  const personal = { ...credential, runtime: { kind: 'user' as const, id: 41, generation: 7 } }
  const credentialPath = join(root, 'credential.json')
  await writeFile(credentialPath, JSON.stringify(personal))
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credentialPath
  const ctx = new Context()
  ctx.provide('connection', {} as never)
  await ctx.plugin(GatewayRuntime)
  const headers = { [GATEWAY_PRINCIPAL_HEADER]: issue({
    user: { id: 9, username: 'admin', displayName: 'Admin', role: 'admin' }, purpose: 'plugin-admin',
    runtime: personal.runtime, scope: { kind: 'personal' },
  }) }
  const called = vi.fn(async () => {})
  try {
    const methods = ['catalog', 'listPlugins', 'listBundles', 'inspect', 'setPluginEnabled', 'setBundleEnabled', 'installBundle', 'cancelInstall', 'removeBundle']
    for (const method of methods) {
      await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: `/api/pluginManager/${method}`, headers }, called)
    }
    await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: '/api/pluginInventory/list', headers }, called)
    for (const pathname of ['/api/settings.describe', '/api/settings.mutate']) {
      await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname, headers }, called)
    }
    expect(called).toHaveBeenCalledTimes(12)
    for (const request of [
      { kind: 'http' as const, method: 'POST', pathname: '/api/terminal/adminList' },
      { kind: 'http' as const, method: 'POST', pathname: '/api/settings.replace' },
      { kind: 'http' as const, method: 'POST', pathname: '/api/settings.openDocument' },
      { kind: 'http' as const, method: 'POST', pathname: '/api/credentials.set' },
      { kind: 'http' as const, method: 'POST', pathname: '/api/pluginManager/futureMethod' },
      { kind: 'http' as const, method: 'GET', pathname: '/api/pluginManager/listPlugins' },
      { kind: 'upgrade' as const, pathname: '/api/pluginManager/listPlugins' },
      { kind: 'http' as const, method: 'GET', pathname: '/api/pluginManager/catalog' },
      { kind: 'upgrade' as const, pathname: '/api/pluginManager/catalog' },
    ]) await expect(async () => ctx.waterfall('connection/request', { ...request, headers }, called)).rejects.toThrow('only profile management')
    expect(called).toHaveBeenCalledTimes(12)
    expect(() => verifyGatewayPrincipal(issue({ purpose: 'plugin-admin', runtime: personal.runtime, scope: { kind: 'personal' } }), personal))
      .toThrow()
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
