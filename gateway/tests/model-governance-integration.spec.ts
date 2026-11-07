import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { applyModelGovernanceToUser, ensureModelGovernanceForUser, refreshModelGovernance, scheduleModelGovernanceRefresh, writeModelGovernanceFile } from '../src/apply-model-governance.ts'
import type { GatewayModelGovernanceService } from '../src/services.ts'
import { AuditService } from '../src/audit.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { ModelGovernanceService, type ModelRegistrationEvent, type UsageEvent } from '../src/model-governance.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'
import { UserService } from '../src/users.ts'
import { GatewayPerformanceObserver } from '../src/performance-observer.ts'
import { PostgresCheckoutQueueFullError } from '../src/postgres/database.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
})

async function fixture(timeZone = 'Asia/Shanghai') {
  const root = mkdtempSync(join(tmpdir(), 'hgw-model-int-'))
  const db = openDb(join(root, 'gateway.sqlite'))
  closers.push(async () => {
    try { db.close() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const cfg = testConfig(root, { HGW_USERS_ROOT: join(root, 'users'), HGW_USAGE_TIME_ZONE: timeZone })
  const users = new UserService(db, cfg)
  const user = await users.create({ username: 'metered-user', password: 'pw-12345678' })
  const governance = new ModelGovernanceService(db, timeZone)
  governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
    adminAllowed: true, userAllowed: true, inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
  return { root, db, cfg, users, user, governance }
}

function deniedEvent(eventId = 'denied-1'): UsageEvent {
  return { eventId, occurredAt: Date.now(), provider: 'p', model: 'm', purpose: 'assistant',
    credentialSource: 'none', credentialClass: 'unknown', status: 'denied' }
}

describe('model governance integration', () => {
  it('does not rotate intake credentials when an existing policy cannot be read as a file', async () => {
    const { cfg, user, governance } = await fixture()
    const path = await writeModelGovernanceFile(cfg, governance, user)
    rmSync(path); mkdirSync(path)
    const issue = vi.spyOn(governance, 'issueIntakeToken')
    await expect(writeModelGovernanceFile(cfg, governance, user)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(issue).not.toHaveBeenCalled()
    expect(statSync(path).isDirectory()).toBe(true)
  })

  it.each(['null', '[]', '"invalid"', '{'])('repairs malformed persisted policy %j', async previous => {
    const { cfg, user, governance } = await fixture()
    const path = await writeModelGovernanceFile(cfg, governance, user)
    writeFileSync(path, previous)
    await writeModelGovernanceFile(cfg, governance, user)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ defaultAllowed: false, models: [{ allowed: true }] })
  })

  it('preserves the policy and intake credential when stored-token validation fails', async () => {
    const { cfg, user, governance } = await fixture()
    const path = await writeModelGovernanceFile(cfg, governance, user)
    const before = readFileSync(path, 'utf8')
    const failure = new Error('Stored intake credential lookup unavailable')
    vi.spyOn(governance, 'subjectForIntakeToken').mockImplementationOnce(() => { throw failure })
    const issue = vi.spyOn(governance, 'issueIntakeToken')
    await expect(writeModelGovernanceFile(cfg, governance, user)).rejects.toBe(failure)
    expect(issue).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('skips disabled accounts in direct and bulk projection without blocking active accounts', async () => {
    const { cfg, users, user, governance } = await fixture()
    const active = await users.create({ username: 'active-policy-owner', password: 'pw-12345678' })
    users.setStatus(user.id, 'disabled')
    await expect(applyModelGovernanceToUser({ cfg, users, governance }, user.id)).resolves.toBeUndefined()
    await expect(refreshModelGovernance({ cfg, users, governance, projects: { list: () => [] } })).resolves.toBeUndefined()
    expect(existsSync(join(cfg.usersRoot, user.username, 'dsh', 'model-governance.json'))).toBe(false)
    expect(existsSync(join(cfg.usersRoot, active.username, 'dsh', 'model-governance.json'))).toBe(true)
  })

  it.each(['disabled', 'deleted'] as const)('refuses model projection for a currently %s account', async withdrawal => {
    const { users, user, governance } = await fixture()
    if (withdrawal === 'disabled') users.setStatus(user.id, 'disabled')
    else users.remove(user.id)
    expect(() => governance.policyFor(user)).toThrow(CollaborationDeniedError)
  })

  it('resolves current account privileges after queued model projection admission', async () => {
    const { cfg, users, user, governance } = await fixture()
    await users.create({ username: 'keeper-admin', password: 'pw-12345678', role: 'admin' })
    users.setRole(user.id, 'admin')
    const administrator = users.getById(user.id)!
    governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
      adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const service: GatewayModelGovernanceService = governance
    service.projectionWrite = async operation => { entered(); await gate; return operation() }
    const pending = writeModelGovernanceFile(cfg, service, administrator)
    try {
      await waiting
      users.setRole(user.id, 'user')
      release()
      const path = await pending
      expect((JSON.parse(readFileSync(path, 'utf8')) as { models: Array<{ allowed: boolean }> }).models[0]?.allowed).toBe(false)
    } finally { release(); await pending }
  })

  it.each(['eager', 'lazy'] as const)('refreshes %s policy contents after demotion without a model revision change', async mode => {
    const { cfg, users, user, governance } = await fixture()
    await users.create({ username: 'keeper-admin', password: 'pw-12345678', role: 'admin' })
    users.setRole(user.id, 'admin')
    governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
      adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
    const path = await writeModelGovernanceFile(cfg, governance, users.getById(user.id)!)
    const first = JSON.parse(readFileSync(path, 'utf8')) as { intakeToken: string; version: number; models: Array<{ allowed: boolean }> }
    expect(first.models[0]?.allowed).toBe(true)
    users.setRole(user.id, 'user')
    expect(governance.configurationRevision()).toBe(first.version)
    const current = users.getById(user.id)!
    if (mode === 'eager') await writeModelGovernanceFile(cfg, governance, current)
    else await ensureModelGovernanceForUser(cfg, governance, current)
    const second = JSON.parse(readFileSync(path, 'utf8')) as typeof first
    expect(second.models[0]?.allowed).toBe(false)
    expect(second.version).toBe(first.version)
    expect(second.intakeToken).toBe(first.intakeToken)
  })

  it('publishes a newer policy when a refresh request arrives during the preceding pass', async () => {
    const { cfg, users, user, governance } = await fixture()
    const second = await users.create({ username: 'second-metered-user', password: 'pw-12345678' })
    let markEntered!: () => void
    let releaseRead!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const release = new Promise<void>((resolve) => { releaseRead = resolve })
    const readPolicy = governance.policyFor.bind(governance)
    const service: GatewayModelGovernanceService = governance
    vi.spyOn(service, 'policyFor').mockImplementation(async (target) => {
      if (target.id === second.id) {
        markEntered()
        await release
      }
      return readPolicy(target)
    })
    const deps = { cfg, users, governance: service, projects: { list: async () => [] } }
    const policyFile = join(cfg.usersRoot, user.username, 'dsh', 'model-governance.json')
    try {
      scheduleModelGovernanceRefresh(deps)
      await entered
      await vi.waitFor(() => {
        const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as { models: { allowed: boolean }[] }
        expect(policy.models[0]?.allowed).toBe(true)
      })
      governance.upsertModel({ provider: 'p', model: 'm', displayName: 'M', enabled: true,
        adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
      scheduleModelGovernanceRefresh(deps)
      releaseRead()
      await vi.waitFor(() => {
        const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as { models: { allowed: boolean }[] }
        expect(policy.models[0]?.allowed).toBe(false)
      })
    } finally { releaseRead() }
  })

  it.each(['authentication', 'ingestion'] as const)('keeps a valid bill retryable when %s checkout admission is full', async stage => {
    const { user, governance } = await fixture()
    const token = governance.issueIntakeToken({ kind: 'user', id: user.id })
    const ingest = governance.ingest.bind(governance)
    const authenticate = governance.subjectForIntakeToken.bind(governance)
    if (stage === 'authentication') governance.subjectForIntakeToken = () => { throw new PostgresCheckoutQueueFullError(1) }
    else governance.ingest = () => { throw new PostgresCheckoutQueueFullError(1) }
    const server = createUsageIntakeServer(governance)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => server.close(() => resolve())))
    const url = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port) + '/usage'
    const post = () => fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(deniedEvent('capacity-retry')),
    })
    const overloaded = await post()
    expect(overloaded.status).toBe(503)
    expect(await overloaded.json()).toEqual({ error: 'DB_CHECKOUT_QUEUE_FULL' })
    governance.ingest = ingest
    governance.subjectForIntakeToken = authenticate
    const retried = await post()
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ inserted: true })
    const duplicate = await post()
    expect(await duplicate.json()).toMatchObject({ inserted: false })
  })

  it('authenticates intake, deduplicates denial audit, and rejects source/class spoofing', async () => {
    const { db, user, governance } = await fixture()
    const audit = new AuditService(db)
    const token = governance.issueIntakeToken({ kind: 'user', id: user.id })
    const observation = new GatewayPerformanceObserver({ enabled: true, eventLoopResolutionMs: 20 })
    closers.push(async () => { observation.dispose() })
    const server = createUsageIntakeServer(governance, audit, undefined, observation)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/usage`, { method: 'POST', body: '{}' })).status).toBe(401)
    const post = (body: unknown) => fetch(`${base}/usage`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) })
    expect((await post(deniedEvent())).status).toBe(200)
    expect((await post(deniedEvent())).status).toBe(200)
    expect(audit.query({ action: 'model.denied' })).toHaveLength(1)
    const spoofed = { ...deniedEvent('spoof'), status: 'succeeded', credentialSource: 'file', credentialClass: 'company' }
    expect((await post(spoofed)).status).toBe(400)
    expect(observation.snapshot(null).operationClasses.internal).toMatchObject({
      started: 4, completed: 4, inflight: 0, clientErrors: 2,
    })
  })

  it('accepts and deduplicates personal model registration records on the same intake', async () => {
    const { user, governance } = await fixture()
    const token = governance.issueIntakeToken({ kind: 'user', id: user.id })
    const server = createUsageIntakeServer(governance)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const registration: ModelRegistrationEvent = {
      kind: 'model-registration', eventId: 'registration-intake-1', occurredAt: Date.now(),
      provider: 'custom', model: 'chat', action: 'model-created', scope: 'personal',
    }
    const post = () => fetch(`${base}/usage`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(registration) })
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(200)
    expect(governance.registrationReport({ userId: user.id }).summary).toMatchObject({ eventCount: 1, modelCount: 1 })
  })

  it('writes a private policy, reuses its valid token, and reflects changed access', async () => {
    const { cfg, user, governance } = await fixture()
    governance.setUserAccess(user.id, 'p', 'm', false)
    const path = await writeModelGovernanceFile(cfg, governance, user)
    const first = JSON.parse(readFileSync(path, 'utf8')) as {
      intakeToken: string; defaultAllowed: boolean; userDeclaredAllowed: boolean; models: Array<{ allowed: boolean }>
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(first.defaultAllowed).toBe(false)
    expect(first.userDeclaredAllowed).toBe(true)
    expect(first.models[0]?.allowed).toBe(false)
    governance.setUserAccess(user.id, 'p', 'm', true)
    await writeModelGovernanceFile(cfg, governance, user)
    const second = JSON.parse(readFileSync(path, 'utf8')) as typeof first
    expect(second.intakeToken).toBe(first.intakeToken)
    expect(second.models[0]?.allowed).toBe(true)
  })

  it('projects the authorized default into the runtime patch and removes stale defaults', async () => {
    const { cfg, user, governance } = await fixture()
    const patchPath = join(cfg.usersRoot, user.username, 'dsh', 'cordis.patch.yml')
    writeFileSync(patchPath, '- id: custom\n  config:\n    value: kept\n')

    await writeModelGovernanceFile(cfg, governance, user)
    let patch = readFileSync(patchPath, 'utf8')
    expect(patch).toContain('- id: custom')
    expect(patch).toContain('provider: "p"')
    expect(patch).toContain('model: "m"')
    expect(statSync(patchPath).mode & 0o777).toBe(0o600)

    governance.setUserAccess(user.id, 'p', 'm', false)
    await writeModelGovernanceFile(cfg, governance, user)
    patch = readFileSync(patchPath, 'utf8')
    expect(patch).toBe('- id: custom\n  config:\n    value: kept\n')
  })

  it.each([
    '',
    '# empty patch\n',
    '[]\n',
    '[ ] # retained comment\n',
    '---\n[]\n...\n# retained comment\n',
    '---\n...\n',
    '[{ id: custom, config: { value: kept } }]\n',
    '---\n- id: custom\n  config:\n    value: kept\n...\n',
    '- id: custom\n  config:\n    value: !!js "process.cwd()"\n',
    '- id: custom\n  config:\n    value: |\n      # gateway-managed organization default: begin\n      kept text\n      # gateway-managed organization default: end\n',
  ])('keeps the runtime patch loadable when projecting into %j', async source => {
    const { cfg, user, governance } = await fixture()
    const patchPath = join(cfg.usersRoot, user.username, 'dsh', 'cordis.patch.yml')
    writeFileSync(patchPath, source)
    const parse = (text: string) => {
      const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
      expect(document.errors).toEqual([])
      return document.toJS() as { id: string; config: Record<string, unknown> }[]
    }
    const retained = parse(source) ?? []
    await writeModelGovernanceFile(cfg, governance, user)
    const projected = readFileSync(patchPath, 'utf8')
    expect(parse(projected)).toEqual([...retained, { id: 'agent-default-model', config: { provider: 'p', model: 'm' } }])
    await writeModelGovernanceFile(cfg, governance, user)
    expect(readFileSync(patchPath, 'utf8')).toBe(projected)

    governance.setUserAccess(user.id, 'p', 'm', false)
    await writeModelGovernanceFile(cfg, governance, user)
    const removed = readFileSync(patchPath, 'utf8')
    expect(parse(removed)).toEqual(retained)
    if (source.includes('# retained comment')) expect(removed).toContain('# retained comment')
    if (source.includes('!!js')) expect(removed).toContain('!!js')
  })

  it.each(['[', 'value: invalid-root\n', '# gateway-managed organization default: begin\n- id: agent-default-model\n'])('refuses an invalid home patch without overwriting %j', async source => {
    const { cfg, user, governance } = await fixture()
    const patchPath = join(cfg.usersRoot, user.username, 'dsh', 'cordis.patch.yml')
    writeFileSync(patchPath, source)
    await expect(writeModelGovernanceFile(cfg, governance, user)).rejects.toThrow()
    expect(readFileSync(patchPath, 'utf8')).toBe(source)
  })

  it('projects a changed policy without restarting the user instance', async () => {
    const { cfg, user, users, governance } = await fixture()
    governance.setUserAccess(user.id, 'p', 'm', false)
    await expect(applyModelGovernanceToUser({ cfg, users, governance }, user.id)).resolves.toBeUndefined()
    const path = join(cfg.usersRoot, user.username, 'dsh', 'model-governance.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ models: [{ allowed: false }] })
  })

  it('refreshes the catalog from one bounded pass without per-id catalog lookups', async () => {
    const { cfg, user, governance } = await fixture()
    const users = {
      list: async () => [{ ...user, port: 42000, instanceState: 'stopped' }],
      getById: async () => { throw new Error('refresh must use the listed user row') },
    }
    const projects = {
      list: async () => [],
      getById: async () => { throw new Error('refresh must use the listed project row') },
    }
    await expect(refreshModelGovernance({ cfg, users, projects, governance })).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(join(cfg.usersRoot, user.username, 'dsh', 'model-governance.json'), 'utf8')))
      .toMatchObject({ models: [{ provider: 'p', model: 'm' }] })
  })

  it('uses configured natural-month boundaries and supports per-metric inherit/unlimited/custom', async () => {
    const { user, governance } = await fixture('America/New_York')
    governance.setQuota('role', 'user', 100, 200)
    governance.setQuota('user', String(user.id), 'inherit', null)
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-03'))
      .toMatchObject({ tokenLimit: 100, companyCostMicrosLimit: null })
    governance.ingest({ kind: 'user', id: user.id }, { ...deniedEvent('before-midnight'), status: 'succeeded', occurredAt: Date.parse('2026-04-01T03:30:00Z'),
      credentialSource: 'user-env', credentialClass: 'company', usage: { inputTokens: 7, outputTokens: 0 } })
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-03').totalTokens).toBe(7)
    expect(governance.summary({ kind: 'user', id: user.id }, '2026-04').totalTokens).toBe(0)
    governance.setQuota('user', String(user.id), 'inherit', 'inherit')
    expect(governance.summary({ kind: 'user', id: user.id }).companyCostMicrosLimit).toBe(200)
  })
})

it('rechecks maintenance after queueing and owns admitted writes until they settle', async () => {
  const { cfg, user, governance } = await fixture()
  const fenced: import('../src/services.ts').GatewayModelGovernanceService = governance
  let open = true, writers = 0, release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { entered = resolve })
  fenced.projectionWrite = async operation => {
    writers++
    try {
      if (!open) throw new Error('maintenance')
      return await operation()
    } finally { writers-- }
  }
  const readPolicy = governance.policyFor.bind(governance)
  fenced.policyFor = async target => {
    entered()
    await waiting
    return readPolicy(target)
  }
  const first = writeModelGovernanceFile(cfg, fenced, user)
  await began
  expect(writers).toBe(1)
  const queued = writeModelGovernanceFile(cfg, fenced, user)
  const refused = expect(queued).rejects.toThrow('maintenance')
  open = false
  release()
  await first
  await refused
  expect(writers).toBe(0)
  const path = join(cfg.usersRoot, user.username, 'dsh', 'model-governance.json')
  const retained = readFileSync(path, 'utf8')
  await expect(writeModelGovernanceFile(cfg, fenced, user)).rejects.toThrow('maintenance')
  expect(readFileSync(path, 'utf8')).toBe(retained)
  open = true
  await expect(writeModelGovernanceFile(cfg, fenced, user)).resolves.toBe(path)
})
