/** Built Admin forms over authenticated Gateway HTTP; PostgreSQL suites own transaction and storage semantics. */
import { chmod, mkdtemp, mkdir, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { installAdminComputerFixture } from './admin-computer-fixture.ts'
import { loadConfig } from '../../../gateway/src/config.ts'
import { openDb } from '../../../gateway/src/db.ts'
import { AuthService } from '../../../gateway/src/auth.ts'
import { UserService } from '../../../gateway/src/users.ts'
import { ProjectService } from '../../../gateway/src/projects.ts'
import { AuditService } from '../../../gateway/src/audit.ts'
import { InstanceManager } from '../../../gateway/src/instances.ts'
import { RuntimeAccountError } from '../../../gateway/src/launcher.ts'
import { ModelGovernanceService, type OrganizationModelSettingsView } from '../../../gateway/src/model-governance.ts'
import { organizationModelSettingsSchema } from '../../../gateway/src/organization-model-settings.ts'
import { createGatewayServer, type GatewayDeps } from '../../../gateway/src/server.ts'
import { createProxyHandlers } from '../../../gateway/src/proxy.ts'
import { createAdminApiHandler } from '../../../gateway/src/admin-api.ts'
import type { ConversationArchiveRow } from '../../../gateway/src/postgres/conversation-archive-service.ts'
import { NodeConfigurationStore } from '../../../gateway/src/node-config-store.ts'
import { isolatedNodeConfigurationAuthority } from '../../../gateway/tests/node-config-fixture.ts'
import { GatewayTunnelAccess, type TunnelAccessDeps } from '../../../gateway/src/tunnel-access.ts'
import { TunnelCredentialCipher, type TunnelAccessRow } from '../../../gateway/src/postgres/tunnel-access-service.ts'
import { installCloudflared } from '../../../gateway/src/tunnel-supervisor.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'

const DIRECTORY = fileURLToPath(new URL('./snapshots/admin-form-values', import.meta.url))
const GOLDENS = [
  'archive-pending.expected.md', 'archive-purged.expected.md', 'archive-refused.expected.md',
  'audit-metadata.expected.md', 'model-price.expected.md', 'more-navigation.expected.md',
  'node-config-conflict.expected.md', 'node-config-fields.expected.md', 'node-config-review.expected.md', 'pending-edits.expected.md', 'personal-document.expected.md',
  'project-quota.expected.md', 'project-rename-error.expected.md', 'project-runtime-stop.expected.md', 'runtime-account-missing.expected.md', 'runtime-stopped.expected.md',
  'ssh-reference.expected.md', 'webhook-error.expected.md', 'webhook-visibility.expected.md',
]

it('preserves stored values through built forms and keeps every mobile destination reachable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-form-values-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const db = openDb(join(root, 'gateway.sqlite')); cleanup.push(() => db.close())
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_STATE_ROOT: join(root, 'state') })
    await mkdir(cfg.projectsRoot, { recursive: true })
    const governance = new ModelGovernanceService(db)
    const deps: GatewayDeps = { cfg, instances: new InstanceManager(db, cfg), auth: new AuthService(db, cfg),
      users: new UserService(db, cfg), projects: new ProjectService(db, cfg), audit: new AuditService(db), governance }
    const nodeIdentity = { organizationId: 'organization-fixture', nodeId: 'node-fixture' }
    const nodeConfiguration = new NodeConfigurationStore(nodeIdentity, cfg, {}, isolatedNodeConfigurationAuthority)
    await nodeConfiguration.initialize()
    deps.nodeConfiguration = nodeConfiguration
    const deploymentState = { mode: 'maintenance' as const, maintenanceEpoch: '1', writeEpoch: '1', reason: '测试配置流程',
      enteredAt: null, updatedAt: '2026-09-27', nodes: [], writersQuiesced: true }
    deps.maintenance = {
      administration: async () => ({ ...deploymentState, operations: [] }),
      state: async () => deploymentState, listOperations: async () => [],
      enterMaintenance: async () => deploymentState, exitMaintenance: async () => { throw new Error('This form scenario keeps maintenance open') },
      setNodeStatus: async () => { throw new Error('This form scenario has no peer nodes') },
      requestRestore: async () => { throw new Error('This form scenario has no backups') }, logOperation: async () => 'operation-fixture',
    }
    deps.backups = { list: async () => [], get: async () => { throw new Error('No backup selected') },
      record: async () => { throw new Error('This form scenario does not capture data') }, setVerified: async () => { throw new Error('No backup selected') } }
    deps.memoryAccess = { get: async owner => ({ ...owner, enabled: false, revision: '0' }),
      set: async (owner, enabled) => ({ ...owner, enabled: enabled === true, revision: '1' }) }
    deps.progress = {
      digestModelSettings: async () => ({ model: null, candidates: [] }),
      setDigestModel: async () => { throw new Error('This form scenario does not change the digest model') },
      progressForUser: async () => { throw new Error('This form scenario does not read a project journal') },
      generateNow: async () => { throw new Error('This form scenario does not generate a project journal') },
    }
    const runtimeActions: unknown[] = []
    const stopInstance = deps.instances.stop.bind(deps.instances)
    deps.instances.stop = async (target, reason) => {
      if (typeof target !== 'number' && target.kind === 'project') runtimeActions.push(target)
      else await stopInstance(target, reason)
    }
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const project = await deps.projects.create({ name: 'Form fixture', createdBy: admin.id })
    await deps.projects.create({ name: 'Taken', createdBy: admin.id })
    const quota = { source: 'independent' as const, tokenLimit: 12_345, companyCostMicrosLimit: 8_500_000 }
    const quotaWrites: unknown[] = []
    const boundSetQuota = governance.setQuota.bind(governance)
    Object.assign(governance, {
      projectQuota: () => quota,
      // Project writes stay recorded for the legacy dialog; role and user
      // subjects are recorded and hit the real SQLite store so the reads
      // below are genuine.
      setQuota: (kind: 'role' | 'user' | 'project', id: string, tokens: number | null | 'inherit', cost: number | null | 'inherit') => {
        quotaWrites.push({ kind, id, tokens, cost })
        if (kind === 'project') return
        boundSetQuota(kind, id, tokens, cost)
      },
      // Read-only organization editors still require the mounted pi-ai namespace.
      describeOrganizationModelSettings: (): OrganizationModelSettingsView => ({
        writable: false, hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai', schema: organizationModelSettingsSchema(),
          value: { providers: {} }, base: { providers: {} }, user: { providers: {} },
          applies: 'live', secrets: [], revision: 0,
        }],
      }),
      describeOrganizationCredentials: () => ({}),
    })
    const model = { provider: 'org-fixture', model: 'model-a', displayName: 'Price fixture A', enabled: false,
      adminAllowed: false, userAllowed: false, inputMicrosPerMillion: 1_234_567, outputMicrosPerMillion: 2_345_678,
      cacheReadMicrosPerMillion: 1, cacheWriteMicrosPerMillion: 0 }
    for (const letter of ['a', 'b', 'c']) governance.upsertModel({ ...model, model: `model-${letter}`, displayName: `Price fixture ${letter.toUpperCase()}` })
    const target = { publicId: 1, name: 'SSH fixture', host: 'fixture-host', node: '/usr/bin/node', helper: '/opt/helper.mjs',
      helperHash: '0'.repeat(64), workspace: '/work', bootstrapPath: null, bootstrapHash: null,
      passwordRef: 'SSH_FIXTURE_PASSWORD', requestTimeoutMs: null, maxFrameBytes: null, maxPending: null,
      leaseMs: null, enabled: false, revision: '1', sharedProjects: [] }
    const sshWrites: unknown[] = []
    deps.sshTargets = {
      list: async () => [target],
      create: async () => { throw new Error('This form scenario edits an existing target') },
      update: async (value: unknown) => { sshWrites.push(value); return target },
      mutate: async () => { throw new Error('This form scenario does not mutate target state') },
      share: async () => { throw new Error('This form scenario does not share a target') },
      shareAsAdministrator: async () => { throw new Error('This form scenario does not share a target') },
      resolveForRuntime: async () => { throw new Error('This form scenario does not start SSH execution') },
      listForProject: async () => { throw new Error('This form scenario does not list project targets') },
    }
    deps.webhookEndpoints = {
      list: async () => [],
      create: async () => { throw new Error('Invalid form input must be rejected before an HTTP write') },
      update: async () => { throw new Error('This form scenario registers an endpoint') },
      mutate: async () => { throw new Error('This form scenario does not mutate endpoint state') },
    }
    let archive: ConversationArchiveRow = {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Gateway browser types use a separate compiler program.
      archiveId: '22000000-0000-4000-8000-000000000022' as ConversationArchiveRow['archiveId'],
      rootSessionId: 'archive-fixture', title: '归档清理示例', contentPreview: '需要保留的对话内容',
      creator: { id: admin.id, displayName: 'Admin fixture' }, project: null,
      runtime: { kind: 'user', id: admin.id,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Gateway browser types use a separate compiler program.
        runtimeId: '33000000-0000-4000-8000-000000000033' as NonNullable<ConversationArchiveRow['runtime']['runtimeId']> },
      workspace: null, state: 'trash', archivedAt: Date.UTC(2026, 8, 27), restoredAt: null, trashedAt: Date.UTC(2026, 8, 28),
      purgeAfter: null, syncState: 'synced', childCount: 0, messageCount: 1, updatedAt: Date.UTC(2026, 8, 27),
    }
    let archiveReads = 0, archivePurges = 0
    deps.archives = {
      adminList: async () => [archive],
      status: async (id: string) => { expect(id).toBe(archive.archiveId); return archive },
      detail: async (id: string) => {
        expect(id).toBe(archive.archiveId)
        archiveReads++
        return { record: archive, descendants: [], hasMore: false, events: [
          { sessionId: archive.rootSessionId, seq: 0, type: 'user/message', time: archive.archivedAt,
            data: { content: [{ type: 'text', text: '需要保留的对话内容' }] } },
        ] }
      },
      purge: async (id: string) => { expect(id).toBe(archive.archiveId); archivePurges++; archive = { ...archive, syncState: 'pending', lastSyncError: undefined }; return true },
    } as unknown as GatewayDeps['archives']
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 0, estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0 }
    const personalDocument = { catalogId: '11111111-1111-4111-8111-111111111111', scope: { kind: 'personal', label: '个人' },
      docId: 'fixture-doc', directoryId: 'fixture-directory', name: 'Fixture document', bytes: 7, mediaType: 'text/plain',
      modifiedAt: 1, owner: { id: admin.id, username: 'admin', displayName: 'Admin fixture' }, ownerSource: 'upload',
      state: 'active', legacy: false, lineageRootId: null }
    const adminReads = new Map<string, number>()
    const adminHandler = createAdminApiHandler(deps)
    const proxy = createProxyHandlers(deps)
    cleanup.push(() => { proxy.close() })
    installAdminComputerFixture(deps)
    const server = createGatewayServer(deps, {
      ...proxy,
      adminRoot: resolve('gateway/public/admin'),
      admin: async (req, res, user, path, body) => {
        if (req.method === 'GET') {
          const owner = typeof req.headers.referer === 'string' ? new URL(req.headers.referer).pathname : ''
          const key = `${owner} ${path}`
          adminReads.set(key, (adminReads.get(key) ?? 0) + 1)
        }
        const documentValue = path === '/admin/api/documents' ? { documents: [personalDocument] }
          : path === `/admin/api/documents/${personalDocument.catalogId}` ? { document: personalDocument, history: [], copies: [] }
            : path === '/admin/api/documents/metrics' ? { total: 1, active: 1, deleted: 0, personal: 1, project: 0, bytes: 7, operations24h: 0, failures24h: 0 }
              : undefined
        if (documentValue !== undefined && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(documentValue)); return true
        }
        const value = path === '/admin/api/usage'
          ? { ...zero, month: '2026-09', tokenLimit: quota.tokenLimit, companyCostMicrosLimit: quota.companyCostMicrosLimit, alerts: [] }
          : path === '/admin/api/usage/overview'
            ? { month: '2026-09', timeZone: 'Asia/Shanghai', personal: zero, projects: zero, unattributedProjects: zero,
              users: [{ userId: admin.id, username: 'admin',
                personal: { ...zero, month: '2026-09', tokenLimit: null, companyCostMicrosLimit: null, alerts: [] },
                projectContribution: zero }] }
            : path === '/admin/api/usage/health'
              ? { month: '2026-09', timeZone: 'Asia/Shanghai', missingUsageCalls: 0, unattributedProjectCalls: 0,
                unattributedProjectTokens: 0, unpricedCalls: 0, historicalUnknownCalls: 0, maxIntakeLagMs: 0 }
              : path === '/admin/api/usage/contributors'
                ? { month: '2026-09', timeZone: 'Asia/Shanghai', projectId: project.id, rows: [], unattributed: zero }
                : path === '/admin/api/project-model-access'
                  ? { projectDefaultAllowed: false, effective: { version: 1, defaultAllowed: false, models: [] }, overrides: [] }
                  : path === '/admin/api/tunnel'
                    ? { supported: true, binary: null, mode: 'off', desired: 'stopped', state: 'stopped',
                      publicUrl: null, hostname: null, domain: null, apiTokenConfigured: false,
                      lastError: null, revision: 0, startedAt: null, updatedAt: '2026-10-01T00:00:00.000Z' }
                    : undefined
        if (value !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return true }
        return adminHandler(req, res, user, path, body)
      },
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else done() })
    }))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; cfg.publicOrigins.push(base)
    const browser = await chromium.launch(); cleanup.push(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: 'light', timezoneId: 'Asia/Shanghai' })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    // Expected 4xx responses also log "Failed to load resource" console errors;
    // skip those for the deliberately refused admin writes below.
    const refusalPaths = /^\/admin\/api\/(projects\/\d+(?:\/instance\/start)?|deployment\/configuration)$/
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const url = message.location().url
      if (url !== undefined && url !== '' && refusalPaths.test(new URL(url).pathname)) return
      errors.push(`console: ${message.text()} (${url})`)
    })
    const httpFailures: string[] = []
    page.on('response', (response) => {
      if (response.status() < 400) return
      const { pathname } = new URL(response.url())
      httpFailures.push(`${response.status()} ${response.request().method()} ${pathname}`)
    })
    const login = await page.request.post(`${base}/login`, { form: { username: 'admin', password: 'fixture-password' }, headers: { origin: base }, maxRedirects: 0 })
    expect(login.status()).toBe(302)
    await page.goto(`${base}/admin/projects/${project.id}`)
    await page.getByRole('button', { name: '停止实例', exact: true }).click()
    const runtimeDialog = page.getByRole('dialog', { name: '停止项目实例', exact: true })
    expect(runtimeActions).toEqual([])
    await compareOrRefreshGolden(join(DIRECTORY, 'project-runtime-stop.expected.md'), await runtimeDialog.ariaSnapshot(), webSnapshotMode())
    await runtimeDialog.getByRole('button', { name: '确认执行', exact: true }).click()
    await runtimeDialog.waitFor({ state: 'hidden' })
    expect(runtimeActions).toEqual([{ kind: 'project', id: project.id }])
    const ensureRunning = deps.instances.ensureRunning.bind(deps.instances)
    const accountFailure = new RuntimeAccountError('harness-project', 'missing', { cause: new Error('/private/command-output') })
    deps.instances.ensureRunning = async () => { throw accountFailure }
    await page.getByRole('button', { name: '启动实例', exact: true }).click()
    const startDialog = page.getByRole('dialog', { name: '启动项目实例', exact: true })
    await startDialog.getByRole('button', { name: '确认执行', exact: true }).click()
    await startDialog.getByRole('alert').getByText(accountFailure.message, { exact: true }).waitFor()
    expect(await startDialog.innerText()).not.toContain('/private/command-output')
    await compareOrRefreshGolden(join(DIRECTORY, 'runtime-account-missing.expected.md'), await startDialog.ariaSnapshot(), webSnapshotMode())
    await startDialog.getByRole('button', { name: '取消', exact: true }).click()
    deps.instances.ensureRunning = ensureRunning
    await page.getByRole('button', { name: '重命名', exact: true }).click()
    const renameDialog = page.getByRole('dialog', { name: '重命名项目', exact: true })
    await renameDialog.getByLabel('项目名称', { exact: true }).fill('Taken')
    await renameDialog.getByRole('button', { name: '保存名称', exact: true }).click()
    await renameDialog.getByRole('alert').waitFor({ state: 'visible' })
    expect(await renameDialog.getByLabel('项目名称', { exact: true }).inputValue()).toBe('Taken')
    expect((await deps.projects.getById(project.id))?.name).toBe('Form fixture')
    await compareOrRefreshGolden(join(DIRECTORY, 'project-rename-error.expected.md'), await renameDialog.ariaSnapshot(), webSnapshotMode())
    await renameDialog.getByLabel('项目名称', { exact: true }).fill('Renamed fixture')
    await renameDialog.getByRole('button', { name: '保存名称', exact: true }).click()
    await renameDialog.waitFor({ state: 'hidden' })
    expect((await deps.projects.getById(project.id))?.name).toBe('Renamed fixture')
    await page.getByRole('button', { name: '配置额度', exact: true }).click()
    const quotaDialog = page.getByRole('dialog', { name: '配置项目额度', exact: true })
    expect(await quotaDialog.getByLabel('每月 Token', { exact: true }).inputValue()).toBe('12345')
    expect(await quotaDialog.getByLabel('每月人民币元', { exact: true }).inputValue()).toBe('8.5')
    await compareOrRefreshGolden(join(DIRECTORY, 'project-quota.expected.md'), await quotaDialog.ariaSnapshot(), webSnapshotMode())
    await quotaDialog.getByRole('button', { name: '保存额度', exact: true }).click()
    await expect.poll(() => quotaWrites).toEqual([{ kind: 'project', id: String(project.id), tokens: 12345, cost: 8500000 }])

    await page.goto(`${base}/admin/usage`)
    await page.locator('.usageTable').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '配置额度', exact: true }).click()
    const usageQuota = page.getByRole('dialog', { name: '配置月度额度', exact: true })
    await expect.poll(async () => usageQuota.getByRole('button', { name: '保存额度', exact: true }).isEnabled()).toBe(true)
    // A previous page's post-quota refresh does not belong to this page's reads.
    for (const path of ['/admin/api/usage/overview', '/admin/api/users', '/admin/api/usage/health']) {
      expect(adminReads.get(`/admin/usage ${path}`), `Usage initial GET ${path}`).toBe(1)
    }
    const roleTokens = usageQuota.locator('fieldset', { hasText: 'Token 额度' })
    const roleCost = usageQuota.locator('fieldset', { hasText: '公司成本额度' })
    await roleTokens.getByRole('combobox', { name: '额度模式' }).selectOption('custom')
    const roleTokenInput = roleTokens.getByLabel('每月 Token', { exact: true })
    await roleTokenInput.fill('42000')
    // inputValue tracks the DOM property; the value attribute only moves with a
    // React controlled render, proving the component committed the draft.
    await expect.poll(async () => roleTokenInput.inputValue()).toBe('42000')
    await expect.poll(async () => roleTokenInput.getAttribute('value')).toBe('42000')
    await roleCost.getByRole('combobox', { name: '额度模式' }).selectOption('custom')
    const roleCostInput = roleCost.getByLabel('每月人民币元', { exact: true })
    await roleCostInput.fill('9.250001')
    await expect.poll(async () => roleCostInput.inputValue()).toBe('9.250001')
    await expect.poll(async () => roleCostInput.getAttribute('value')).toBe('9.250001')
    await usageQuota.getByRole('button', { name: '保存额度', exact: true }).click()
    await usageQuota.waitFor({ state: 'hidden' })
    expect(governance.roleQuota('user')).toEqual({ tokenLimit: 42_000, companyCostMicrosLimit: 9_250_001 })
    await page.getByRole('button', { name: '配置额度', exact: true }).click()
    const usageReopen = page.getByRole('dialog', { name: '配置月度额度', exact: true })
    await expect.poll(async () => usageReopen.getByRole('button', { name: '保存额度', exact: true }).isEnabled()).toBe(true)
    expect(await usageReopen.getByLabel('每月 Token', { exact: true }).inputValue()).toBe('42000')
    expect(await usageReopen.getByLabel('每月人民币元', { exact: true }).inputValue()).toBe('9.250001')
    // Editing tokens alone keeps the stored micro-precision cost unchanged.
    const reopenedTokens = usageReopen.getByLabel('每月 Token', { exact: true })
    await reopenedTokens.fill('777')
    await expect.poll(async () => reopenedTokens.inputValue()).toBe('777')
    await expect.poll(async () => reopenedTokens.getAttribute('value')).toBe('777')
    await usageReopen.getByRole('button', { name: '保存额度', exact: true }).click()
    await usageReopen.waitFor({ state: 'hidden' })
    expect(quotaWrites[quotaWrites.length - 1]).toEqual({ kind: 'role', id: 'user', tokens: 777, cost: 9_250_001 })
    expect(governance.roleQuota('user')).toEqual({ tokenLimit: 777, companyCostMicrosLimit: 9_250_001 })
    await page.getByRole('button', { name: '配置额度', exact: true }).click()
    const usageUserDialog = page.getByRole('dialog', { name: '配置月度额度', exact: true })
    await expect.poll(async () => usageUserDialog.getByRole('button', { name: '保存额度', exact: true }).isEnabled()).toBe(true)
    await usageUserDialog.getByRole('combobox', { name: '配置对象' }).selectOption('user')
    const userSave = usageUserDialog.getByRole('button', { name: '保存额度', exact: true })
    await expect.poll(async () => userSave.isEnabled()).toBe(true)
    const userTokens = usageUserDialog.locator('fieldset', { hasText: 'Token 额度' })
    await userTokens.getByRole('combobox', { name: '额度模式' }).selectOption('custom')
    const userTokenInput = userTokens.getByLabel('每月 Token', { exact: true })
    await userTokenInput.fill('777')
    await expect.poll(async () => userTokenInput.inputValue()).toBe('777')
    await expect.poll(async () => userTokenInput.getAttribute('value')).toBe('777')
    await userSave.click()
    await usageUserDialog.waitFor({ state: 'hidden' })
    expect(governance.userQuota(admin.id)).toEqual({
      tokenMode: 'custom', tokenLimit: 777, companyCostMode: 'inherit', companyCostMicrosLimit: null,
    })

    const beforeDeployment = new URL(page.url()).pathname
    await page.locator('.sidebarNav').getByRole('link', { name: '部署', exact: true }).click()
    const networkSettings = page.getByRole('group', { name: '访问与监听', exact: true })
    await networkSettings.getByRole('textbox', { name: 'Gateway 端口（1–65535）', exact: true }).waitFor()
    await compareOrRefreshGolden(join(DIRECTORY, 'node-config-fields.expected.md'), await networkSettings.ariaSnapshot(), webSnapshotMode())
    const editable = networkSettings.locator('input').first()
    const originalValue = await editable.inputValue()
    await editable.fill(`${Number(originalValue) + 1}`)
    await page.locator('.sidebarNav').getByRole('link', { name: '模型', exact: true }).click()
    const pendingEdits = page.getByRole('dialog', { name: '保留当前编辑', exact: true })
    await pendingEdits.waitFor()
    await compareOrRefreshGolden(join(DIRECTORY, 'pending-edits.expected.md'), await pendingEdits.ariaSnapshot(), webSnapshotMode())
    expect(await pendingEdits.getByRole('link', { name: '在新标签页打开' }).getAttribute('target')).toBe('_blank')
    await pendingEdits.getByRole('button', { name: '留在当前页面', exact: true }).click()
    expect(await editable.inputValue()).toBe(`${Number(originalValue) + 1}`)
    await page.goBack()
    await pendingEdits.waitFor()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/deployment')
    expect(await pendingEdits.getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe(beforeDeployment)
    await pendingEdits.getByRole('button', { name: '留在当前页面', exact: true }).click()
    expect(await editable.inputValue()).toBe(`${Number(originalValue) + 1}`)
    await editable.fill(originalValue)
    await networkSettings.getByRole('textbox', { name: 'Gateway 端口（1–65535）', exact: true }).fill('9330')
    await page.getByRole('button', { name: '保存待应用配置', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已保存待应用配置' }).waitFor()
    expect((await nodeConfiguration.view(admin.id)).effective.HGW_PORT).toBe('8899')
    expect((await nodeConfiguration.view(admin.id)).desired.HGW_PORT).toBe('9330')
    await page.getByRole('button', { name: '应用并重启', exact: true }).click()
    const configurationDialog = page.getByRole('dialog', { name: '应用节点配置并重启', exact: true })
    await compareOrRefreshGolden(join(DIRECTORY, 'node-config-review.expected.md'), await configurationDialog.ariaSnapshot(), webSnapshotMode())
    const latest = await nodeConfiguration.view(admin.id)
    await nodeConfiguration.save(nodeIdentity, latest.revision, { ...latest.desired, HGW_PORT: '9340' }, admin.id)
    await configurationDialog.getByRole('button', { name: '确认应用并重启', exact: true }).click()
    await configurationDialog.getByRole('alert').waitFor({ state: 'visible' })
    await compareOrRefreshGolden(join(DIRECTORY, 'node-config-conflict.expected.md'), await configurationDialog.ariaSnapshot(), webSnapshotMode())
    expect((await nodeConfiguration.view(admin.id)).operation).toBeNull()
    await configurationDialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('section', { has: networkSettings }).getByRole('button', { name: '重新读取', exact: true }).click()
    await expect.poll(async () => networkSettings.getByRole('textbox', { name: 'Gateway 端口（1–65535）', exact: true }).inputValue()).toBe('9340')
    await page.getByRole('button', { name: '应用并重启', exact: true }).click()
    await configurationDialog.getByRole('button', { name: '确认应用并重启', exact: true }).click()
    await configurationDialog.waitFor({ state: 'hidden' })
    expect((await nodeConfiguration.view(admin.id)).operation).toMatchObject({ status: 'pending', revision: 2, writeEpoch: '1' })

    await page.goto(`${base}/admin/ssh`)
    await page.getByRole('option', { name: /Renamed fixture/u }).waitFor({ state: 'attached' })
    expect(adminReads.get('/admin/ssh /admin/api/projects')).toBe(1)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const sshDialog = page.getByRole('dialog', { name: '编辑 SSH fixture', exact: true })
    const reference = sshDialog.getByLabel('密码凭据引用', { exact: false })
    expect(await reference.inputValue()).toBe('SSH_FIXTURE_PASSWORD')
    await compareOrRefreshGolden(join(DIRECTORY, 'ssh-reference.expected.md'), await reference.locator('..').ariaSnapshot(), webSnapshotMode())
    await sshDialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => sshWrites).toMatchObject([{ targetId: 1, revision: '1', fields: { passwordRef: 'SSH_FIXTURE_PASSWORD' } }])

    await page.goto(`${base}/admin/models`)
    await page.locator('.organizationModelsEditor').getByText('当前部署的设置文档为只读。', { exact: true }).waitFor()
    expect(adminReads.get('/admin/models /admin/api/model-settings')).toBe(1)
    await page.getByRole('button', { name: '权限与计价', exact: true }).click()
    await page.getByRole('button', { name: '配置模型治理', exact: true }).first().click()
    const priceDialog = page.getByRole('dialog', { name: '配置模型治理', exact: true })
    expect(await priceDialog.getByLabel('缓存读取', { exact: true }).inputValue()).toBe('0.000001')
    await compareOrRefreshGolden(join(DIRECTORY, 'model-price.expected.md'), await priceDialog.ariaSnapshot(), webSnapshotMode())
    await priceDialog.getByRole('button', { name: '保存治理配置', exact: true }).click()
    await priceDialog.waitFor({ state: 'hidden' })
    expect(governance.listModels().find(row => row.model === 'model-a')).toEqual(model)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.mobileList .priceSummary').last().waitFor({ state: 'visible' })
    await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight) })
    const footer = await page.locator('.mobileNav').boundingBox()
    const finalPrice = await page.locator('.mobileList .priceSummary').last().boundingBox()
    if (footer === null || finalPrice === null) throw new Error('Mobile comparison regions are missing')
    expect(footer.height).toBeLessThan(100)
    expect(finalPrice.y + finalPrice.height).toBeLessThanOrEqual(footer.y + 1)
    await page.getByRole('button', { name: '更多管理功能', exact: true }).click()
    const more = page.getByRole('dialog', { name: '更多管理功能', exact: true })
    await compareOrRefreshGolden(join(DIRECTORY, 'more-navigation.expected.md'), await more.ariaSnapshot(), webSnapshotMode())
    expect(await more.getByRole('link').count()).toBe(10)
    await more.getByLabel('界面语言', { exact: true }).selectOption('en')
    await page.getByRole('button', { name: 'More administration features', exact: true }).waitFor()
    expect(await page.evaluate(() => localStorage.getItem('coharness-admin-language'))).toBe('en')
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    expect(await page.evaluate(() => document.cookie.includes('hgw_lang=en'))).toBe(true)
    await page.getByRole('button', { name: 'More administration features', exact: true }).click()
    const moreEn = page.getByRole('dialog', { name: 'More administration features', exact: true })
    await moreEn.getByRole('link', { name: 'Terminals', exact: true }).click()
    await page.getByRole('combobox', { name: 'Terminal scope', exact: true })
      .getByRole('option', { name: /Renamed fixture/u }).waitFor({ state: 'attached' })
    expect(adminReads.get('/admin/terminals /admin/api/projects')).toBe(1)
    await page.getByRole('heading', { name: 'Terminals', exact: true }).waitFor()
    await page.getByRole('button', { name: 'More administration features', exact: true }).click()
    await page.getByRole('dialog', { name: 'More administration features', exact: true })
      .getByLabel('Interface language', { exact: true }).selectOption('zh')
    await page.getByRole('heading', { name: '终端', exact: true }).waitFor()
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh')

    await page.goto(`${base}/admin/ssh`)
    const targetTable = page.getByRole('table')
    const removeTarget = targetTable.getByRole('button', { name: '删除', exact: true })
    await removeTarget.waitFor({ state: 'visible' })
    const targetViewport = targetTable.locator('..')
    const viewportBox = await targetViewport.boundingBox()
    const initialRemoveBox = await removeTarget.boundingBox()
    if (viewportBox === null || initialRemoveBox === null) throw new Error('SSH table action regions are missing')
    expect(initialRemoveBox.x + initialRemoveBox.width).toBeGreaterThan(viewportBox.x + viewportBox.width)
    await page.mouse.move(viewportBox.x + viewportBox.width / 2, initialRemoveBox.y + initialRemoveBox.height / 2)
    await page.mouse.wheel(2_000, 0)
    await expect.poll(async () => {
      const button = await removeTarget.boundingBox()
      return button !== null && button.x >= viewportBox.x
        && button.x + button.width <= viewportBox.x + viewportBox.width
    }).toBe(true)
    await targetTable.getByRole('button', { name: '编辑', exact: true }).click()
    await sshDialog.waitFor({ state: 'visible' })
    await sshDialog.getByRole('button', { name: '取消', exact: true }).click()

    await page.goto(`${base}/admin/webhooks`)
    await page.getByRole('button', { name: '注册端点', exact: true }).click()
    const webhookDialog = page.getByRole('dialog', { name: '注册 Webhook 端点', exact: true })
    await webhookDialog.getByRole('button', { name: '保存', exact: true }).click()
    const alert = webhookDialog.getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    await compareOrRefreshGolden(join(DIRECTORY, 'webhook-error.expected.md'), await alert.ariaSnapshot(), webSnapshotMode())
    await webhookDialog.getByRole('combobox', { name: /^运行时类型/ }).selectOption('project')
    const visibility = webhookDialog.getByRole('combobox', { name: /^新会话可见性/ })
    expect(await visibility.inputValue()).toBe('project')
    await visibility.selectOption('private')
    await compareOrRefreshGolden(join(DIRECTORY, 'webhook-visibility.expected.md'), await visibility.locator('..').ariaSnapshot(), webSnapshotMode())
    await page.setViewportSize({ width: 1400, height: 1000 })
    await page.goto(`${base}/admin/documents`)
    await page.getByRole('button', { name: '查看详情', exact: true }).click()
    const documentDialog = page.getByRole('dialog', { name: 'Fixture document', exact: true })
    await documentDialog.waitFor({ state: 'visible' })
    expect(await documentDialog.getByRole('button', { name: '转移所有权', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(join(DIRECTORY, 'personal-document.expected.md'), await documentDialog.ariaSnapshot(), webSnapshotMode())

    await page.goto(`${base}/admin/archives`)
    await page.getByRole('button', { name: '查看 归档清理示例', exact: true }).click()
    const archiveDialog = page.getByRole('dialog', { name: '归档清理示例', exact: true })
    const purge = async () => {
      await archiveDialog.getByRole('button', { name: '彻底删除', exact: true }).click()
      await page.getByRole('dialog', { name: '彻底删除所选对话？', exact: true })
        .getByRole('button', { name: '彻底删除', exact: true }).click()
    }
    await purge()
    await archiveDialog.getByText('处理中·等待实例', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(DIRECTORY, 'archive-pending.expected.md'), await archiveDialog.locator('.archiveDetail').ariaSnapshot(), webSnapshotMode())
    expect(archiveReads).toBe(1)
    expect(archivePurges).toBe(1)
    archive = { ...archive, syncState: 'conflict', lastSyncError: '会话仍有运行中的终端，请关闭终端后重试。' }
    await archiveDialog.getByRole('alert').getByText(archive.lastSyncError!, { exact: true }).waitFor()
    await compareOrRefreshGolden(join(DIRECTORY, 'archive-refused.expected.md'), await archiveDialog.locator('.archiveDetail').ariaSnapshot(), webSnapshotMode())
    expect(archiveReads).toBe(1)
    await purge()
    await archiveDialog.getByText('处理中·等待实例', { exact: true }).waitFor()
    archive = { ...archive, syncState: 'synced', state: 'purged' }
    await archiveDialog.getByText('已彻底删除', { exact: true }).waitFor()
    expect(await archiveDialog.getByText('需要保留的对话内容', { exact: true }).count()).toBe(0)
    expect(archivePurges).toBe(2)
    expect(archiveReads).toBe(1)
    await compareOrRefreshGolden(join(DIRECTORY, 'archive-purged.expected.md'), await archiveDialog.locator('.archiveDetail').ariaSnapshot(), webSnapshotMode())

    await deps.audit.write({ userId: admin.id, action: 'admin.fixture.audit', status: 200,
      detail: JSON.stringify({ targetId: 17, revision: '12', state: 'unknown', password: 'not-public' }) })
    await page.setViewportSize({ width: 1400, height: 1000 })
    await page.goto(`${base}/admin/audit`)
    const auditRow = page.getByRole('row').filter({ hasText: 'admin.fixture.audit' })
    await auditRow.waitFor({ state: 'visible' })
    expect(await auditRow.innerText()).toContain('请求成功')
    expect(await auditRow.innerText()).not.toContain('not-public')
    await compareOrRefreshGolden(join(DIRECTORY, 'audit-metadata.expected.md'), await auditRow.locator('dl').ariaSnapshot(), webSnapshotMode())
    await deps.instances.stop(admin.id)
    await page.goto(base)
    await page.getByRole('button', { name: '启动并打开', exact: true }).waitFor({ state: 'visible' })
    expect(await deps.instances.isLive(admin.id)).toBe(false)
    expect(await page.locator('meta[http-equiv="refresh"]').count()).toBe(0)
    await compareOrRefreshGolden(join(DIRECTORY, 'runtime-stopped.expected.md'), await page.locator('main').ariaSnapshot(), webSnapshotMode())
    const deliberateRefusals = [
      /^4\d\d PATCH \/admin\/api\/projects\/\d+$/,
      /^4\d\d POST \/admin\/api\/deployment\/configuration$/,
      /^409 POST \/admin\/api\/projects\/\d+\/instance\/start$/,
    ]
    expect(httpFailures.filter(entry => !deliberateRefusals.some(pattern => pattern.test(entry)))).toEqual([])
    expect(errors).toEqual([])
  } finally {
    const failures: unknown[] = []
    for (const dispose of cleanup.reverse()) { try { await dispose() } catch (error) { failures.push(error) } }
    if (failures.length > 0) throw new AggregateError(failures, 'Admin form fixture cleanup failed')
  }
}, 60_000)

it('owns the Admin form and mobile navigation goldens', async () => { expect((await readdir(DIRECTORY)).sort()).toEqual(GOLDENS) })

it('cancels an unregistered connector through the built Admin and reports clipboard refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-tunnel-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const binary = join(root, 'cloudflared-fixture')
    const executable = new URL('../../../gateway/tests/fixtures/tunnel-binary.mjs', import.meta.url).href
    await writeFile(binary, `#!${process.execPath}\nimport { runTunnelBinary } from ${JSON.stringify(executable)};\nawait runTunnelBinary(${JSON.stringify(root)});\n`)
    await chmod(binary, 0o700)
    let row: TunnelAccessRow = {
      mode: 'off', desired: 'stopped', state: 'stopped', publicUrl: null, hostname: null, domain: null,
      zoneId: null, accountId: null, tunnelId: null, apiTokenCipher: null, runTokenCipher: null,
      lastError: null, revision: 1, startedAt: null, updatedAt: '2026-10-25T00:00:00Z',
    }
    // Storage behavior has PostgreSQL acceptance; this browser fixture only
    // retains quick-mode fields while running the real controller and child.
    const store: TunnelAccessDeps['store'] = {
      get: async () => row,
      update: async (patch) => {
        row = { ...row, mode: patch.mode ?? row.mode, desired: patch.desired ?? row.desired, state: patch.state ?? row.state,
          publicUrl: patch.public_url === undefined ? row.publicUrl : patch.public_url,
          lastError: patch.last_error === undefined ? row.lastError : patch.last_error,
          startedAt: patch.started_at === undefined ? row.startedAt : patch.started_at, revision: row.revision + 1 }
        return row
      },
    }
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_STATE_ROOT: join(root, 'state') })
    const db = openDb(join(root, 'gateway.sqlite')); cleanup.push(() => db.close())
    let binaryAvailable = false, failedDownloadCancelled = false
    const tunnel = new GatewayTunnelAccess({ store, cipher: new TunnelCredentialCipher(randomBytes(32)),
      organizationId: 'browser-fixture', nodeId: 'browser-node', target: 'http://127.0.0.1:1', stateDir: join(root, 'tunnel'),
      startupTimeoutMs: 30_000, closeTimeoutMs: 5000, probeIntervalMs: 25,
      resolveBinary: async () => binaryAvailable ? { path: binary, version: 'fixture', source: 'env' } : null,
      install: (state, signal) => installCloudflared(state, async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { failedDownloadCancelled = true },
      }), { status: 503 }), signal),
    })
    cleanup.push(() => tunnel.shutdown())
    const deps: GatewayDeps = { cfg, instances: new InstanceManager(db, cfg), auth: new AuthService(db, cfg),
      users: new UserService(db, cfg), projects: new ProjectService(db, cfg), audit: new AuditService(db), tunnelAccess: tunnel }
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const handler = createAdminApiHandler(deps)
    let failRead = true, tunnelReads = 0
    let initialReadEntered!: () => void, releaseInitialRead!: () => void
    const initialReadPending = new Promise<void>((resolve) => { initialReadEntered = resolve })
    const initialReadRelease = new Promise<void>((resolve) => { releaseInitialRead = resolve })
    const server = createGatewayServer(deps, { ...createProxyHandlers(deps), admin: async (req, res, user, path, body) => {
      if (path === '/admin/api/tunnel') {
        tunnelReads++
        if (failRead) {
          initialReadEntered()
          await initialReadRelease
          failRead = false
          res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture-read-unavailable' })); return true
        }
      }
      return handler(req, res, user, path, body)
    } })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else done() })
    }))
    cleanup.push(() => { releaseInitialRead() })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; cfg.publicOrigins.push(base)
    const browser = await chromium.launch(); cleanup.push(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, colorScheme: 'light' })
    await page.clock.install()
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const login = await page.request.post(`${base}/login`, { form: { username: 'admin', password: 'fixture-password' }, headers: { origin: base }, maxRedirects: 0 })
    expect(login.status()).toBe(302)
    await page.goto(`${base}/admin/deployment`)
    const section = page.locator('section', { has: page.getByRole('heading', { name: '公网访问', exact: true }) })
    const snapshots = fileURLToPath(new URL('./snapshots/admin-tunnel-access', import.meta.url))
    if (webSnapshotMode() === 'refresh') await mkdir(snapshots, { recursive: true })
    const snapshot = async (name: string) => compareOrRefreshGolden(join(snapshots, `${name}.expected.md`),
      (await section.ariaSnapshot()).replaceAll(root, '<fixture>'), webSnapshotMode())
    await initialReadPending
    await section.getByText('正在加载隧道状态', { exact: true }).waitFor()
    await page.clock.runFor(20_000)
    expect(tunnelReads).toBe(1)
    const pendingReadSnapshot = (await section.ariaSnapshot()).replaceAll(root, '<fixture>')
    releaseInitialRead()
    await section.getByRole('alert').waitFor({ timeout: 15_000 })
    expect(tunnelReads).toBe(1)
    await compareOrRefreshGolden(join(snapshots, 'slow-read-pending.expected.md'), pendingReadSnapshot, webSnapshotMode())
    await snapshot('read-failure')
    await section.getByRole('button', { name: '重新读取', exact: true }).click()
    await section.getByRole('button', { name: '安装 cloudflared', exact: true }).click()
    await section.getByRole('alert').filter({ hasText: 'cloudflared download failed with HTTP 503' }).waitFor()
    expect(failedDownloadCancelled).toBe(true)
    await snapshot('download-failure')
    binaryAvailable = true
    await page.reload()
    await section.getByRole('button', { name: '开启临时链接', exact: true }).click()
    let witness: { controlUrl: string; probeToken: string } | undefined
    await expect.poll(async () => {
      try {
        const observed: unknown = JSON.parse(await readFile(join(root, 'tunnel-quick.prepared'), 'utf8'))
        if (typeof observed !== 'object' || observed === null || !('controlUrl' in observed) || !('probeToken' in observed)
          || typeof observed.controlUrl !== 'string' || typeof observed.probeToken !== 'string') throw new Error('Malformed connector witness')
        witness = { controlUrl: observed.controlUrl, probeToken: observed.probeToken }
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          const view = await tunnel.view()
          if (view.state === 'error') throw new Error(view.lastError ?? 'Connector failed before its prepared witness')
          return false
        }
        throw error
      }
    }, { timeout: 10_000 }).toBe(true)
    expect((await tunnel.view()).state).toBe('starting')
    await snapshot('starting')
    await section.getByRole('button', { name: '停止隧道', exact: true }).click()
    await section.getByText('隧道已停止', { exact: true }).waitFor()
    expect((await tunnel.view()).state).toBe('stopped')
    if (witness === undefined) throw new Error('Connector preparation witness missing')
    await expect(fetch(witness.controlUrl)).rejects.toBeInstanceOf(TypeError)
    expect(await section.getByRole('alert').count()).toBe(0)
    await snapshot('stopped')

    await writeFile(join(root, 'tunnel-quick.register'), 'register\n')
    await section.getByRole('button', { name: '开启临时链接', exact: true }).click()
    await section.getByRole('link', { name: 'https://fixture.trycloudflare.com', exact: true }).waitFor()
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Fixture clipboard refusal', 'NotAllowedError') },
    } }) })
    await section.getByRole('button', { name: '复制链接', exact: true }).click()
    await section.getByText('复制失败，请手动选择并复制链接', { exact: true }).waitFor()
    await snapshot('copy-failure')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    const stop = section.getByRole('button', { name: '停止隧道', exact: true })
    await stop.scrollIntoViewIfNeeded()
    const bounds = await stop.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await stop.click()
    await section.getByText('隧道已停止', { exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally {
    const failures: unknown[] = []
    for (const dispose of cleanup.reverse()) { try { await dispose() } catch (error) { failures.push(error) } }
    if (failures.length > 0) throw new AggregateError(failures, 'Admin tunnel fixture cleanup failed')
  }
}, 60_000)
