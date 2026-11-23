/** Independent Admin dialogs reached through authenticated pages and isolated API outcomes. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page, Request } from 'playwright'
import { afterAll, assert, beforeAll, expect, it } from 'vitest'
import { startAdminResponsiveFixture } from './admin-responsive-fixture.ts'
import { auditAdminState, auditAdminTouchTargets } from './admin-responsive-state.ts'
import { responsiveBrowser, responsiveMobileEmulation } from './responsive-browser.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'
import type {
  AdminDocumentDetail, AdminUser, DeploymentState, ModelRegistrationReport, NodeConfigurationView,
  OrganizationModelSettingsView, ProjectDetail, TunnelAccessView, UsageOverview,
} from '../../../gateway/admin-ui/src/api.ts'
import type { GovernanceRebuildStatus } from '../../../gateway/src/governance-rebuild-review.ts'
import type { DeploymentContext, NodeConnectionView } from '../../../gateway/src/deployment-protocol.ts'

interface Reply { status?: number; body: unknown }
type ReplySource = Reply | ((request: Request) => Reply | Promise<Reply>)
const matrix = process.env.DSH_FEATURE_MATRIX === '1'
const timeout = matrix ? 600_000 : 60_000
let fixture: Awaited<ReturnType<typeof startAdminResponsiveFixture>>
let browser: Browser
beforeAll(async () => {
  fixture = await startAdminResponsiveFixture()
  browser = await responsiveBrowser.launch(process.env.DSH_TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.DSH_TEST_BROWSER_EXECUTABLE } : undefined)
})
afterAll(async () => { await browser?.close(); await fixture?.close() })

async function visit(path: string, operation: (page: Page, replies: Map<string, ReplySource>) => Promise<void>,
  organization = false): Promise<void> {
  fixture.state.scope = organization ? 'organization' : 'local'
  fixture.state.mode = 'loaded'
  fixture.state.recovery = 'loaded'
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true,
    isMobile: responsiveMobileEmulation, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  const replies = new Map<string, ReplySource>()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const intercept = async (route: Parameters<Parameters<Page['route']>[1]>[0]): Promise<void> => {
    const request = route.request()
    const source = replies.get(`${request.method()} ${new URL(request.url()).pathname}`)
    if (source === undefined) { await route.fallback(); return }
    const reply = typeof source === 'function' ? await source(request) : source
    await route.fulfill({ status: reply.status ?? 200, json: reply.body })
  }
  await page.route('**/admin/api/**', intercept)
  await page.route('**/account/api/**', intercept)
  try {
    const login = await page.request.post(`${fixture.base}/login`, { form: { username: 'admin', password: 'fixture-password' },
      headers: { origin: fixture.base }, maxRedirects: 0 })
    expect(login.status()).toBe(302)
    await page.goto(`${fixture.base}/admin${path}`)
    await page.getByRole('heading', { level: 1 }).waitFor()
    // WebKit surfaces fetches killed by an early reload as unhandled
    // "access control checks" rejections; let the page settle first.
    await page.waitForLoadState('networkidle')
    await operation(page, replies)
    expect(errors).toEqual([])
  } finally { await page.close() }
}

async function state(page: Page, name: string, surface: Locator): Promise<void> {
  await surface.waitFor({ state: 'visible' })
  if (!matrix && ['remote-endpoint-invalid', 'remote-grant-refused', 'ssh-sharing-refused',
    'ssh-deletion-refused', 'document-trash-refused', 'project-delete-refused', 'webhook-delete-refused',
    'steward-grant-refused', 'user-membership-remove-refused'].includes(name)) {
    await compareOrRefreshGolden(join(dirname(fileURLToPath(import.meta.url)), 'snapshots/admin-dialog-states', `${name}.expected.md`),
      await surface.ariaSnapshot(), webSnapshotMode())
  }
  await auditAdminState(page, name, surface)
}

async function close(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().tap()
  await dialog.waitFor({ state: 'hidden' })
}

async function pendingReply(replies: Map<string, ReplySource>, key: string, reply: Reply,
  trigger: () => Promise<void>, inspect: () => Promise<void>): Promise<void> {
  let arrived = false
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  replies.set(key, async () => { arrived = true; await released; return reply })
  try { await trigger(); await expect.poll(() => arrived, { timeout: 10_000 }).toBe(true); await inspect() }
  finally { release(); replies.set(key, reply) }
}

const runtimeId = '33000000-0000-4000-8000-000000000033'
const refusal: Reply = { status: 409, body: { error: 'QA write refused. The reviewed record remains unchanged.' } }

const catalogReads = [
  ['users', '/users', '/users'], ['user-detail', '/users/1', '/users/1'],
  ['projects', '/projects', '/projects'], ['project-detail', '/projects/1', '/projects/1'],
  ['models', '/models', '/models'], ['audit', '/audit', '/audit'],
  ['usage', '/usage', '/usage/overview'], ['documents', '/documents', '/documents'],
  ['archives', '/archives', '/archives/records'], ['ssh', '/ssh', '/ssh-targets'],
  ['deployment', '/deployment', '/deployment'], ['steward', '/steward', '/steward'],
  ['webhooks', '/webhooks', '/webhook-endpoints'], ['desktops', '/desktops', '/desktops'],
  ['remote-desktops', '/remote-desktops', '/remote-desktop/endpoints'],
  ['governance-recovery', '/governance-recovery', '/governance-recovery'],
  ['governance-recovery-local', '/governance-recovery/local', '/governance-recovery/local'],
] as const

it.each(catalogReads)('keeps %s loading, read refusal and recovered content reachable', async (name, path, read) => {
  await visit(path, async (page, replies) => {
    await page.waitForLoadState('networkidle')
    const key = `GET /admin/api${read}`
    const response = await page.request.get(`${fixture.base}/admin/api${read}`)
    expect(response.ok()).toBe(true)
    const restored: Reply = { body: await response.json() }
    const loading = name.startsWith('governance-recovery')
      ? page.getByText('正在读取恢复审核', { exact: true }) : page.locator('.loadingState:visible').first()
    const reveal = async (): Promise<void> => {
      if (name === 'models') await page.getByRole('button', { name: '权限与计价', exact: true }).tap()
    }
    await pendingReply(replies, key, restored,
      async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await reveal() },
      async () => { await loading.waitFor(); await state(page, `${name}-initial-loading`, page.locator('body')) })
    await page.waitForLoadState('networkidle')
    replies.set(key, { status: 503, body: { error: 'QA catalog read unavailable; retry preserves this page.' } })
    await page.reload()
    await reveal()
    await page.locator('.errorBanner:visible').first().waitFor()
    await state(page, `${name}-initial-read-refused`, page.locator('body'))
    replies.delete(key)
    await page.reload()
    await reveal()
    await page.getByRole('heading', { level: 1 }).waitFor()
    await page.waitForLoadState('networkidle')
    expect(await page.locator('.errorBanner:visible').allTextContents()).toEqual([])
    await state(page, `${name}-read-recovered`, page.locator('body'))
  })
}, timeout)

it('keeps project origin filters distinct through loading, no matches and refused reads', async () => {
  await visit('/projects', async (page, replies) => {
    await page.waitForLoadState('networkidle')
    const key = 'GET /admin/api/projects'
    const filter = page.getByRole('group', { name: '项目来源筛选', exact: true })
    const requested: string[] = []
    const capture = (request: Request): void => {
      const url = new URL(request.url())
      if (url.pathname === '/admin/api/projects') requested.push(url.searchParams.get('origin') ?? 'all')
    }
    page.on('request', capture)
    try {
      await pendingReply(replies, key, { body: [] },
        () => filter.getByRole('button', { name: '用户发起', exact: true }).tap(),
        async () => { await page.locator('.loadingState:visible').waitFor(); await state(page, 'projects-origin-loading', page.locator('.page')) })
      await page.getByText('还没有项目', { exact: true }).waitFor()
      expect(requested.at(-1)).toBe('user')
      expect(await filter.getByRole('button', { name: '用户发起', exact: true }).getAttribute('aria-pressed')).toBe('true')
      await state(page, 'projects-user-origin-empty', page.locator('.page'))
      replies.set(key, { status: 503, body: { error: 'QA project directory unavailable.' } })
      await filter.getByRole('button', { name: '管理员发起', exact: true }).tap()
      await page.getByRole('alert').filter({ hasText: 'QA project directory unavailable.' }).waitFor()
      expect(requested.at(-1)).toBe('admin')
      await state(page, 'projects-admin-origin-refused', page.locator('.page'))
      replies.delete(key)
      await filter.getByRole('button', { name: '全部', exact: true }).tap()
      await page.locator('.dataTable tbody tr').first().waitFor()
      expect(requested.at(-1)).toBe('all')
      expect(await page.locator('.errorBanner:visible').allTextContents()).toEqual([])
      await state(page, 'projects-origin-reset', page.locator('.page'))
    } finally { page.off('request', capture) }
  })
}, timeout)

it.each([
  ['documents', '/documents', '文件名或 ID', '没有匹配的文档'],
  ['archives', '/archives/records', '关键词', '没有匹配的对话'],
  ['audit', '/audit', '操作', '没有匹配的记录'],
] as const)('keeps %s filter drafts, empty results, errors and reset behavior separate', async (name, read, label, empty) => {
  await visit(`/${name}`, async (page, replies) => {
    await page.waitForLoadState('networkidle')
    const key = `GET /admin/api${read}`
    const query = 'missing-视觉验收-LongFilterValue012345678901234567890123456789'
    const input = page.getByLabel(label, { exact: true })
    await input.fill(query)
    const expected: Record<string, string> = { q: query }
    if (name === 'documents') {
      await page.getByLabel('作用域', { exact: true }).selectOption('project')
      await page.getByLabel('项目', { exact: true }).selectOption(String(fixture.projectId))
      await page.getByLabel('所有者', { exact: true }).selectOption(String(fixture.adminId))
      await page.getByLabel('状态', { exact: true }).selectOption('trash')
      Object.assign(expected, { scope: 'project', projectId: String(fixture.projectId), ownerUserId: String(fixture.adminId), state: 'trash' })
    } else if (name === 'archives') {
      await page.getByLabel('用户 ID', { exact: true }).fill(String(fixture.adminId))
      await page.getByLabel('项目 ID', { exact: true }).fill(String(fixture.projectId))
      Object.assign(expected, { userId: String(fixture.adminId), projectId: String(fixture.projectId) })
    } else {
      await page.getByLabel('用户', { exact: true }).fill('missing-audit-actor')
      await page.getByLabel('结果', { exact: true }).selectOption('failure')
      Object.assign(expected, { actor: 'missing-audit-actor', outcome: 'failure' })
    }
    await state(page, `${name}-filter-draft`, page.locator('.page'))
    let parameters = new URLSearchParams()
    const capture = (request: Request): void => {
      const url = new URL(request.url())
      if (url.pathname === `/admin/api${read}`) parameters = url.searchParams
    }
    page.on('request', capture)
    try {
      await pendingReply(replies, key, { body: name === 'documents' ? { documents: [] } : [] },
        () => page.getByRole('button', { name: '应用筛选', exact: true }).tap(),
        async () => { await page.locator('.loadingState:visible').first().waitFor(); await state(page, `${name}-filter-loading`, page.locator('.page')) })
      await page.getByText(empty, { exact: true }).waitFor()
      for (const [key, value] of Object.entries(expected)) expect(parameters.get(key), `${name} filter ${key}`).toBe(value)
      expect(await input.inputValue()).toBe(query)
      await state(page, `${name}-filter-empty`, page.locator('.page'))
      replies.set(key, { status: 503, body: { error: 'QA filtered catalog unavailable.' } })
      await page.getByRole('button', { name: '应用筛选', exact: true }).tap()
      await page.getByRole('alert').filter({ hasText: 'QA filtered catalog unavailable.' }).waitFor()
      expect(await input.inputValue()).toBe(query)
      await state(page, `${name}-filter-refused`, page.locator('.page'))
      replies.delete(key)
      await page.getByRole('button', { name: '重置', exact: true }).tap()
      await page.locator('.dataTable tbody tr').first().waitFor()
      for (const key of Object.keys(expected)) {
        expect(parameters.get(key), `${name} reset ${key}`).toBe(name === 'documents' && key === 'state' ? 'active' : null)
      }
      expect(await input.inputValue()).toBe('')
      expect(await page.locator('.errorBanner:visible').allTextContents()).toEqual([])
      await state(page, `${name}-filter-reset`, page.locator('.page'))
    } finally { page.off('request', capture) }
  })
}, timeout)

it('keeps archive ID validation and each empty folder visible without sending an invalid query', async () => {
  await visit('/archives', async (page, replies) => {
    await page.waitForLoadState('networkidle')
    let reads = 0
    replies.set('GET /admin/api/archives/records', () => { reads++; return { body: [] } })
    await page.getByLabel('用户 ID', { exact: true }).fill('-1')
    await page.getByRole('button', { name: '应用筛选', exact: true }).tap()
    await page.getByRole('alert').filter({ hasText: '用户 ID 和项目 ID 必须是正整数' }).waitFor()
    expect(reads).toBe(0)
    await state(page, 'archives-invalid-id-filter', page.locator('.page'))
    await page.getByRole('button', { name: '重置', exact: true }).tap()
    await page.getByText('当前还没有归档对话。', { exact: true }).waitFor()
    const tabs = page.getByRole('group', { name: '按状态查看归档记录', exact: true })
    for (const [name, id, detail] of [['回收站', 'trash', '回收站是空的。'], ['已彻底删除', 'purged', '还没有彻底删除的记录。'],
      ['已归档', 'archived', '当前还没有归档对话。']] as const) {
      await tabs.getByRole('button', { name, exact: true }).tap()
      await page.getByText(detail, { exact: true }).waitFor()
      expect(await tabs.getByRole('button', { name, exact: true }).getAttribute('aria-pressed')).toBe('true')
      await state(page, `archives-${id}-folder-empty`, page.locator('.page'))
    }
  })
}, timeout)

it('keeps the selected usage month visible through empty, refused and recovered reads', async () => {
  await visit('/usage', async (page, replies) => {
    await page.waitForLoadState('networkidle')
    const response = await page.request.get(`${fixture.base}/admin/api/usage/overview`)
    expect(response.ok()).toBe(true)
    const overview = await response.json() as UsageOverview
    const month = page.getByLabel('月份', { exact: true })
    const key = 'GET /admin/api/usage/overview'
    const selected = '2026-09'
    await pendingReply(replies, key, { body: { ...overview, month: selected, users: [] } },
      () => month.fill(selected),
      async () => { await page.getByText('正在加载用量', { exact: true }).waitFor(); await state(page, 'usage-month-loading', page.locator('.page')) })
    await page.getByText('本月暂无用量', { exact: true }).waitFor()
    expect(await month.inputValue()).toBe(selected)
    await state(page, 'usage-selected-month-empty', page.locator('.page'))
    replies.set(key, { status: 503, body: { error: 'QA monthly usage unavailable.' } })
    await month.fill('2026-08')
    await page.getByRole('alert').filter({ hasText: 'QA monthly usage unavailable.' }).waitFor()
    expect(await month.inputValue()).toBe('2026-08')
    await state(page, 'usage-selected-month-refused', page.locator('.page'))
    replies.delete(key)
    await month.fill('2026-11')
    await page.locator('.dataTable tbody tr').first().waitFor()
    expect(await month.inputValue()).toBe('2026-11')
    expect(await page.locator('.errorBanner:visible').allTextContents()).toEqual([])
    await state(page, 'usage-selected-month-recovered', page.locator('.page'))
  })
}, timeout)

it('keeps personal model registration filters and an empty or refused report reachable', async () => {
  await visit('/models', async (page, replies) => {
    await page.waitForLoadState('networkidle')
    const key = 'GET /admin/api/model-registrations'
    const report: ModelRegistrationReport = {
      summary: { providerCount: 0, modelCount: 0, eventCount: 0, createdCount: 0, modifiedCount: 0, deletedCount: 0 }, rows: [],
    }
    await pendingReply(replies, key, { body: report },
      () => page.getByRole('button', { name: '个人登记', exact: true }).tap(),
      async () => { await page.getByText('正在加载个人登记记录', { exact: true }).waitFor(); await state(page, 'model-registration-loading', page.locator('.page')) })
    await page.getByText('暂无个人登记记录', { exact: true }).waitFor()
    await state(page, 'model-registration-empty', page.locator('.page'))
    const provider = 'qa-LongProviderIdentifier012345678901234567890'
    await page.getByLabel('筛选用户', { exact: true }).selectOption(String(fixture.adminId))
    await page.getByLabel('筛选 Provider', { exact: true }).fill(provider)
    await page.getByLabel('筛选模型', { exact: true }).fill('qa-model')
    await page.getByLabel('筛选动作', { exact: true }).selectOption('model-modified')
    await state(page, 'model-registration-filter-draft', page.locator('.page'))
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/admin/api/model-registrations')
    await pendingReply(replies, key, { status: 503, body: { error: 'QA registration report unavailable.' } },
      () => page.getByRole('button', { name: '应用筛选', exact: true }).tap(),
      () => state(page, 'model-registration-filter-pending', page.locator('.page')))
    const parameters = new URL((await requested).url()).searchParams
    expect(parameters.get('userId')).toBe(String(fixture.adminId))
    expect(parameters.get('provider')).toBe(provider)
    expect(parameters.get('model')).toBe('qa-model')
    expect(parameters.get('action')).toBe('model-modified')
    await page.getByRole('alert').filter({ hasText: 'QA registration report unavailable.' }).waitFor()
    expect(await page.getByLabel('筛选 Provider', { exact: true }).inputValue()).toBe(provider)
    await state(page, 'model-registration-filter-refused', page.locator('.page'))
    const populated: ModelRegistrationReport = {
      summary: { providerCount: 1, modelCount: 1, eventCount: 1, createdCount: 0, modifiedCount: 1, deletedCount: 0 },
      rows: [{ eventId: 'qa-registration', userId: fixture.adminId, occurredAt: Date.UTC(2026, 10, 16),
        receivedAt: Date.UTC(2026, 10, 16), provider, model: 'qa-model', action: 'model-modified', scope: 'personal' }],
    }
    replies.set(key, { body: populated })
    await page.getByRole('button', { name: '重置', exact: true }).tap()
    await page.getByText(provider, { exact: true }).filter({ visible: true }).first().waitFor()
    expect(await page.getByLabel('筛选 Provider', { exact: true }).inputValue()).toBe('')
    expect(await page.locator('.errorBanner:visible').allTextContents()).toEqual([])
    await state(page, 'model-registration-reset-populated', page.locator('.page'))
  })
}, timeout)

it('keeps a selected terminal inventory distinct from loading, no retained terminals and read failure', async () => {
  await visit('/terminals', async (page, replies) => {
    await page.waitForLoadState('networkidle')
    const key = 'GET /admin/api/terminals'
    const empty = { nodeId: fixture.nodeId, target: { kind: 'user', id: fixture.adminId, runtimeId }, generation: 1, terminals: [] }
    await pendingReply(replies, key, { body: empty },
      async () => { await page.getByRole('combobox', { name: '终端运行范围', exact: true }).selectOption(`user:${fixture.adminId}`) },
      async () => { await page.getByText('正在读取终端清单', { exact: true }).waitFor(); await state(page, 'terminal-inventory-loading', page.locator('.page')) })
    await page.getByText('没有保留的终端。', { exact: true }).waitFor()
    await state(page, 'terminal-inventory-empty', page.locator('.page'))
    replies.set(key, { status: 503, body: { error: 'QA terminal inventory unavailable.' } })
    await page.getByRole('button', { name: '刷新终端清单', exact: true }).tap()
    await page.getByRole('alert').filter({ hasText: 'QA terminal inventory unavailable.' }).waitFor()
    expect(await page.getByRole('combobox', { name: '终端运行范围', exact: true }).inputValue()).toBe(`user:${fixture.adminId}`)
    await state(page, 'terminal-inventory-refused', page.locator('.page'))
  })
}, timeout)

it.each(['account', 'node'] as const)('keeps governance %s decisions explicit through refusal and reviewed outcomes', async (kind) => {
  await visit('/governance-recovery', async (page, replies) => {
    const read = 'GET /admin/api/governance-recovery'
    const response = await page.request.get(`${fixture.base}/admin/api/governance-recovery`)
    expect(response.ok()).toBe(true)
    const original = await response.json() as GovernanceRebuildStatus
    const review = { ...original, nodes: original.nodes.map(row => ({ ...row, quarantined: false })) }
    replies.set(read, { body: review })
    await page.reload()
    const subject = kind === 'account' ? review.accounts[0] : review.nodes[0]
    assert.isDefined(subject, `Missing fixture ${kind} for governance review`)
    const subjectId = 'userId' in subject ? subject.userId : subject.nodeId
    const subjectName = 'username' in subject ? subject.username : subject.name
    const begin = page.getByRole('button', { name: `${kind === 'account' ? '审核账号' : '审核电脑'} ${subjectName}`, exact: true })
    const draft = page.locator('section', { has: page.getByRole('heading', { name: '当前审核', exact: true }) })
    const decision = draft.getByLabel(kind === 'account' ? '账号登录' : '电脑接入', { exact: true })
    const confirm = draft.getByRole('button', { name: '确认审核', exact: true })
    const acknowledge = draft.getByLabel('我已核对当前对象和上述影响', { exact: true })
    const password = 'QA-reviewed-password-0123456789'
    const key = `POST /admin/api/governance-recovery/${review.operationId}/${kind === 'account' ? 'accounts' : 'nodes'}/${subjectId}/review`
    await begin.tap()
    expect(await decision.inputValue()).toBe('keep-disabled')
    expect(await confirm.isDisabled()).toBe(true)
    await state(page, `governance-${kind}-keep-disabled-draft`, draft)
    await decision.selectOption('restore')
    await acknowledge.check()
    if (kind === 'account') {
      await draft.getByLabel('新密码', { exact: true }).fill('short')
      expect(await confirm.isDisabled()).toBe(true)
      await state(page, 'governance-account-short-password', draft)
      await draft.getByLabel('新密码', { exact: true }).fill(password)
    }
    expect(await confirm.isEnabled()).toBe(true)
    await state(page, `governance-${kind}-restore-ready`, draft)
    const submitted = page.waitForRequest(request => `${request.method()} ${new URL(request.url()).pathname}` === key)
    await pendingReply(replies, key, { status: 503, body: { error: 'qa-review-unavailable' } }, () => confirm.tap(),
      async () => { expect(await confirm.isDisabled()).toBe(true); await state(page, `governance-${kind}-review-pending`, draft) })
    expect((await submitted).postDataJSON()).toEqual({ confirm: review.operationId, revision: review.revision, decision: 'restore',
      ...(kind === 'account' ? { newPassword: password } : {}) })
    await page.getByRole('alert').filter({ hasText: 'qa-review-unavailable' }).waitFor()
    expect(await decision.inputValue()).toBe('restore')
    expect(await acknowledge.isChecked()).toBe(true)
    if (kind === 'account') expect(await draft.getByLabel('新密码', { exact: true }).inputValue()).toBe(password)
    await state(page, `governance-${kind}-review-refused`, page.locator('.page'))
    const restored: GovernanceRebuildStatus = { ...review, revision: '2',
      accounts: review.accounts.map(row => ({ ...row, decision: kind === 'account' ? 'restore' : row.decision })),
      nodes: review.nodes.map(row => ({ ...row, decision: kind === 'node' ? 'restore' : row.decision })) }
    replies.set(read, { body: restored })
    replies.set(key, { body: { revision: '2' } })
    await confirm.tap()
    await draft.waitFor({ state: 'hidden' })
    await page.getByText('已审核恢复', { exact: true }).waitFor()
    await state(page, `governance-${kind}-reviewed`, page.locator('.page'))
    await begin.tap()
    await acknowledge.check()
    expect(await decision.inputValue()).toBe('keep-disabled')
    const disabled: GovernanceRebuildStatus = { ...restored, revision: '3',
      accounts: restored.accounts.map(row => ({ ...row, decision: kind === 'account' ? 'keep-disabled' : row.decision })),
      nodes: restored.nodes.map(row => ({ ...row, decision: kind === 'node' ? 'keep-disabled' : row.decision })) }
    replies.set(read, { body: disabled })
    const kept = page.waitForRequest(request => `${request.method()} ${new URL(request.url()).pathname}` === key)
    await pendingReply(replies, key, { body: { revision: '3' } }, () => confirm.tap(),
      () => state(page, `governance-${kind}-keep-disabled-pending`, draft))
    expect((await kept).postDataJSON()).toEqual({ confirm: review.operationId, revision: '2', decision: 'keep-disabled' })
    await draft.waitFor({ state: 'hidden' })
    await page.getByText('保持禁用', { exact: true }).waitFor()
    await state(page, `governance-${kind}-kept-disabled`, page.locator('.page'))
  })
}, timeout)

it('requires renewed governance review after a conflict and hides stale authority after a denied write', async () => {
  await visit('/governance-recovery', async (page, replies) => {
    const read = 'GET /admin/api/governance-recovery'
    const response = await page.request.get(`${fixture.base}/admin/api/governance-recovery`)
    expect(response.ok()).toBe(true)
    const review = await response.json() as GovernanceRebuildStatus
    const account = review.accounts[0]
    assert.isDefined(account, 'Missing fixture account for renewed governance review')
    const key = `POST /admin/api/governance-recovery/${review.operationId}/accounts/${account.userId}/review`
    const draft = page.locator('section', { has: page.getByRole('heading', { name: '当前审核', exact: true }) })
    const confirm = draft.getByRole('button', { name: '确认审核', exact: true })
    const renew = draft.getByRole('button', { name: '使用已核对的新版本', exact: true })
    await page.getByRole('button', { name: `审核账号 ${account.username}`, exact: true }).tap()
    await draft.getByLabel('账号登录', { exact: true }).selectOption('restore')
    const password = draft.getByLabel('新密码', { exact: true })
    await password.fill('QA-preserved-password-0123456789')
    await draft.getByLabel('我已核对当前对象和上述影响', { exact: true }).check()
    replies.set(key, { status: 409, body: { error: 'peer-backup/governance-review-changed' } })
    await confirm.tap()
    await page.getByRole('alert').filter({ hasText: '审核版本已变化' }).waitFor()
    expect(await confirm.isDisabled()).toBe(true)
    expect(await renew.isDisabled()).toBe(true)
    await state(page, 'governance-review-version-conflict', page.locator('.page'))
    replies.set(read, { body: { ...review, revision: '2' } })
    await page.getByRole('button', { name: '刷新审核状态', exact: true }).tap()
    await page.getByText('审核版本 2', { exact: true }).waitFor()
    expect(await password.inputValue()).toBe('QA-preserved-password-0123456789')
    expect(await confirm.isDisabled()).toBe(true)
    expect(await renew.isEnabled()).toBe(true)
    await state(page, 'governance-refreshed-review-unconfirmed', draft)
    await renew.tap()
    expect(await draft.getByLabel('我已核对当前对象和上述影响', { exact: true }).isChecked()).toBe(false)
    expect(await password.inputValue()).toBe('QA-preserved-password-0123456789')
    await state(page, 'governance-renewed-review-draft', draft)
    await draft.getByLabel('我已核对当前对象和上述影响', { exact: true }).check()
    replies.set(key, { status: 403, body: { error: 'governance-recovery-bootstrap-required' } })
    await confirm.tap()
    await page.getByRole('alert').filter({ hasText: '当前账号不能执行恢复审核' }).waitFor()
    await draft.waitFor({ state: 'hidden' })
    expect(await page.locator('.governanceRecoveryPage [hidden][inert]').count()).toBe(1)
    await state(page, 'governance-write-authority-denied', page.locator('.page'))
    await page.getByRole('button', { name: '刷新审核状态', exact: true }).tap()
    await draft.waitFor({ state: 'visible' })
    expect(await password.inputValue()).toBe('QA-preserved-password-0123456789')
    expect(await page.locator('.errorBanner:visible').allTextContents()).toEqual([])
    await state(page, 'governance-authority-read-restored', page.locator('.page'))
  })
}, timeout)

it('requires every unrestored domain acknowledgement before releasing organization management', async () => {
  await visit('/governance-recovery', async (page, replies) => {
    const read = 'GET /admin/api/governance-recovery'
    const response = await page.request.get(`${fixture.base}/admin/api/governance-recovery`)
    expect(response.ok()).toBe(true)
    const original = await response.json() as GovernanceRebuildStatus
    const review: GovernanceRebuildStatus = { ...original, unreconfiguredItems: [{ table: 'organization-models', recordDigest: 'a'.repeat(64),
      identity: { provider: 'qa-LongOrganizationProviderIdentifier012345678901234567890123456789' } }] }
    replies.set(read, { body: review })
    await page.reload()
    await page.locator('summary').filter({ hasText: '查看管理标识' }).tap()
    await state(page, 'governance-configuration-identities-expanded', page.locator('.page'))
    await page.getByRole('button', { name: '开放管理入口', exact: true }).tap()
    const draft = page.locator('section', { has: page.getByRole('heading', { name: '当前审核', exact: true }) })
    const confirm = draft.getByRole('button', { name: '确认审核', exact: true })
    expect(await confirm.isDisabled()).toBe(true)
    await state(page, 'governance-release-unacknowledged', draft)
    await draft.getByLabel('我知道这些内容尚未恢复，开放入口后仍需分别处理', { exact: true }).check()
    expect(await confirm.isDisabled()).toBe(true)
    await state(page, 'governance-release-domains-unacknowledged', draft)
    await draft.getByLabel('电脑、项目、模型与插件授权', { exact: true }).check()
    expect(await confirm.isEnabled()).toBe(true)
    await state(page, 'governance-release-ready', draft)
    const key = `POST /admin/api/governance-recovery/${review.operationId}/release`
    const submitted = page.waitForRequest(request => `${request.method()} ${new URL(request.url()).pathname}` === key)
    await pendingReply(replies, key, { status: 503, body: { error: 'qa-release-unavailable' } }, () => confirm.tap(),
      () => state(page, 'governance-release-pending', draft))
    expect((await submitted).postDataJSON()).toEqual({ confirm: review.operationId, revision: review.revision,
      acknowledgeUnrestoredDomains: review.unrestoredDomains })
    await page.getByRole('alert').filter({ hasText: 'qa-release-unavailable' }).waitFor()
    expect(await draft.getByLabel('电脑、项目、模型与插件授权', { exact: true }).isChecked()).toBe(true)
    await state(page, 'governance-release-refused', page.locator('.page'))
    replies.set(read, { body: { ...review, state: 'released', revision: '2' } })
    replies.set(key, { body: { revision: '2' } })
    await confirm.tap()
    await draft.waitFor({ state: 'hidden' })
    const ordinaryAdmin = page.getByRole('link', { name: '打开管理后台', exact: true })
    await ordinaryAdmin.waitFor()
    expect(await ordinaryAdmin.getAttribute('href')).toBe('/admin/')
    await state(page, 'governance-management-released', page.locator('.page'))
  })
}, timeout)

it('keeps local recovery binding drafts and retained-data checks visible through refusal and submission', async () => {
  await visit('/governance-recovery/local', async (page, replies) => {
    const read = 'GET /admin/api/governance-recovery/local'
    const response = await page.request.get(`${fixture.base}/admin/api/governance-recovery/local`)
    expect(response.ok()).toBe(true)
    const review = await response.json() as Pick<GovernanceRebuildStatus, 'operationId' | 'runtimes'>
    const runtime = review.runtimes[0]
    assert.isDefined(runtime, 'Missing fixture runtime for local recovery binding')
    const key = `POST /admin/api/governance-recovery/${review.operationId}/runtimes/${runtime.id}/bind-data`
    await page.getByRole('button', { name: '查看此 Runtime', exact: true }).tap()
    await state(page, 'local-recovery-unbound-data-review', page.locator('.page'))
    await page.locator('summary').filter({ hasText: '指定本机数据位置' }).tap()
    const homePath = '/qa/LongRetainedAccountHome012345678901234567890123456789'
    const runtimeHome = '/qa/LongRetainedRuntimeHome012345678901234567890123456789'
    const home = page.getByLabel('工作目录绝对路径', { exact: true })
    const retainedRuntime = page.getByLabel('Runtime 数据目录（可选）', { exact: true })
    const bind = page.getByRole('button', { name: '核验所选目录', exact: true })
    expect(await bind.isDisabled()).toBe(true)
    await home.fill(homePath)
    await retainedRuntime.fill(runtimeHome)
    await state(page, 'local-recovery-manual-location-draft', page.locator('.page'))
    const submitted = page.waitForRequest(request => `${request.method()} ${new URL(request.url()).pathname}` === key)
    await pendingReply(replies, key, { status: 409, body: { error: 'peer-backup/governance-local-account-home-conflict' } },
      () => bind.tap(), async () => {
        expect(await home.isDisabled()).toBe(true)
        expect(await bind.isDisabled()).toBe(true)
        await state(page, 'local-recovery-location-check-pending', page.locator('.page'))
      })
    expect((await submitted).postDataJSON()).toEqual({ confirm: runtime.id, selection: { homePath, runtimeHome } })
    await page.getByRole('alert').filter({ hasText: '此账号在本机已有不同的数据目录' }).waitFor()
    expect(await home.inputValue()).toBe(homePath)
    expect(await retainedRuntime.inputValue()).toBe(runtimeHome)
    await state(page, 'local-recovery-location-conflict', page.locator('.page'))
    replies.set(read, { body: { ...review, runtimes: review.runtimes.map(row => ({ ...row, dataBinding: 'queued' })) } })
    replies.set(key, { body: { accepted: true } })
    await bind.tap()
    await page.getByText('所属电脑正在核验数据', { exact: true }).waitFor()
    await page.getByRole('status').filter({ hasText: '已提交数据核验；刷新查看结果' }).waitFor()
    expect(await home.inputValue()).toBe('')
    expect(await retainedRuntime.inputValue()).toBe('')
    expect(await page.getByRole('button', { name: '核验本机数据', exact: true }).isDisabled()).toBe(true)
    await state(page, 'local-recovery-data-verification-queued', page.locator('.page'))
  })
}, timeout)

it('distinguishes small touch actions from labeled checkbox targets and prose links', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  try {
    await page.setContent('<button style="width:43px;height:44px">Save</button>')
    await expect(auditAdminTouchTargets(page, page.locator('body'))).rejects.toThrow('44×44')
    await page.setContent('<label style="display:inline-flex;width:44px;height:44px"><input type="checkbox"></label>'
      + '<p>Read <a href="#details">details</a>.</p><button disabled style="height:20px">Unavailable</button>')
    await auditAdminTouchTargets(page, page.locator('body'))
  } finally { await page.close() }
})

it('keeps each personal Runtime operation and its unconfirmed result reachable', async () => {
  await visit(`/users/${fixture.adminId}`, async (page, replies) => {
    const section = page.locator('section', { has: page.getByRole('button', { name: '刷新 Runtime', exact: true }) })
    for (const [action, name] of [['启动', 'start'], ['停止', 'stop'], ['重启', 'restart'], ['退役', 'retire']] as const) {
      await section.getByRole('button', { name: action, exact: true }).filter({ visible: true }).tap()
      const dialog = page.getByRole('dialog')
      await state(page, `user-runtime-${name}-confirm`, dialog)
      await pendingReply(replies, `POST /admin/api/runtimes/${runtimeId}/${name}`, refusal,
        () => dialog.getByRole('button', { name: action, exact: true }).tap(),
        () => state(page, `user-runtime-${name}-pending`, dialog))
      await dialog.getByRole('alert').waitFor()
      await state(page, `user-runtime-${name}-refresh-required`, dialog)
      expect(await dialog.getByRole('button', { name: action, exact: true }).isDisabled()).toBe(true)
      await close(dialog)
      await section.getByRole('button', { name: '刷新 Runtime', exact: true }).tap()
      await expect.poll(() => section.getByRole('button', { name: action, exact: true }).filter({ visible: true }).isEnabled()).toBe(true)
    }
  })
}, timeout)

it('reviews personal directory and document publication without publishing host data', async () => {
  await visit(`/users/${fixture.adminId}`, async (page, replies) => {
    const directoryPath = `/admin/api/runtimes/${runtimeId}/personal-directory/promote`
    const documentsPath = `/admin/api/documents/personal/${fixture.adminId}/migration`
    const directory = { nodeId: fixture.nodeId, runtimeId, userId: fixture.adminId, generation: 0,
      revision: 1, workspaces: 4, conversations: 18, published: false, ready: true }
    const documents = { nodeId: fixture.nodeId, user: fixture.adminId, ready: true, blockers: [],
      rootId: 'qa-documents', catalogDigest: 'qa-catalog', physicalDigest: 'qa-physical', counts: { fileCount: 12, historyCount: 26 } }
    const dialog = page.getByRole('dialog', { name: '本机历史数据', exact: true })
    await pendingReply(replies, `GET ${directoryPath}`, { body: directory },
      () => page.getByRole('button', { name: '本机历史数据', exact: true }).filter({ visible: true }).tap(),
      () => state(page, 'history-directory-loading', dialog))
    await dialog.getByText('工作区 4 · 对话 18', { exact: true }).waitFor()
    await state(page, 'history-directory-ready', dialog)
    replies.set(`GET ${directoryPath}`, { body: { ...directory, published: true, ready: false } })
    await dialog.getByRole('button', { name: '重新检查', exact: true }).tap()
    await dialog.getByText('此目录已发布。', { exact: true }).waitFor()
    await state(page, 'history-directory-published', dialog)
    replies.set(`GET ${documentsPath}`, { body: { ...documents, ready: false, blockers: ['missing-file-with-a-long-independent-identifier'] } })
    await dialog.getByRole('button', { name: '账号文档', exact: true }).tap()
    await dialog.getByRole('status').filter({ hasText: '尚未满足发布条件' }).waitFor()
    await state(page, 'history-documents-blocked', dialog)
    replies.set(`GET ${documentsPath}`, { status: 503, body: { error: 'DOCUMENT_MIGRATION_UNAVAILABLE' } })
    await dialog.getByRole('button', { name: '重新检查', exact: true }).tap()
    await dialog.getByRole('alert').waitFor()
    await state(page, 'history-documents-unavailable', dialog)
    replies.set(`GET ${documentsPath}`, { body: documents })
    await dialog.getByRole('button', { name: '重新检查', exact: true }).tap()
    await dialog.getByText('文档 12 · 历史事件 26', { exact: true }).waitFor()
    await state(page, 'history-documents-ready', dialog)
    await pendingReply(replies, `POST ${documentsPath}`, refusal,
      () => dialog.getByRole('button', { name: '确认发布', exact: true }).tap(),
      () => state(page, 'history-documents-pending', dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, 'history-documents-refused', dialog)
    await dialog.getByRole('button', { name: '重新检查', exact: true }).tap()
    await dialog.getByText('文档 12 · 历史事件 26', { exact: true }).waitFor()
    replies.set(`POST ${documentsPath}`, { body: { published: true } })
    await dialog.getByRole('button', { name: '确认发布', exact: true }).tap()
    await dialog.getByText('已发布。', { exact: true }).waitFor()
    await state(page, 'history-documents-published', dialog)
  })
}, timeout)

it('keeps endpoint validation and grant refusal visible inside the active remote-desktop form', async () => {
  await visit('/remote-desktops', async (page, replies) => {
    await page.getByRole('button', { name: '添加端点', exact: true }).tap()
    const endpoint = page.getByRole('dialog', { name: '添加远程端点', exact: true })
    await state(page, 'remote-endpoint-ready', endpoint)
    await endpoint.getByRole('button', { name: '保存', exact: true }).tap()
    await endpoint.getByRole('alert').waitFor()
    await state(page, 'remote-endpoint-invalid', endpoint)
    await close(endpoint)
    replies.set('POST /admin/api/remote-desktop/grants', { status: 409, body: { error: 'remote-desktop-grant-exists' } })
    await page.getByRole('button', { name: '签发授权', exact: true }).tap()
    const grant = page.getByRole('dialog')
    await grant.locator('input[list]').fill('admin')
    await state(page, 'remote-grant-ready', grant)
    await grant.getByRole('button', { name: '签发授权', exact: true }).tap()
    await grant.getByRole('alert').waitFor()
    await state(page, 'remote-grant-refused', grant)
    await close(grant)
    for (const action of ['撤销', '删除']) {
      await page.getByRole('button', { name: action, exact: true }).first().tap()
      const confirm = page.getByRole('dialog')
      await state(page, action === '撤销' ? 'remote-revoke-confirm' : 'remote-remove-endpoint-confirm', confirm)
      await close(confirm)
    }
  })
}, timeout)

it('exposes separate node enrollment, credential and removal states without changing a real computer', async () => {
  await visit('/deployment', async (page, replies) => {
    const accessPath = '/admin/api/deployment/nodes/access'
    const enrollmentPath = '/admin/api/deployment/nodes/enrollments'
    const candidatePath = '/admin/api/deployment/topology/candidates'
    const name = 'QA computer with a deliberately long independent display name'
    replies.set(`GET ${accessPath}`, { body: { items: [{ nodeId: fixture.remoteNodeId, name, revision: 1,
      status: 'disconnected', platform: 'linux', architecture: 'arm64', lastSeenAt: null, leaseExpiresAt: null, executionReady: false }], nextCursor: null } })
    replies.set(`GET ${candidatePath}`, { body: { items: [{ nodeId: fixture.remoteNodeId, name }], nextCursor: null } })
    await page.reload()
    const section = page.locator('section', { has: page.getByRole('heading', { name: '接入电脑', exact: true }) })
    await section.getByRole('button', { name: '添加电脑', exact: true }).tap()
    let dialog = page.getByRole('dialog', { name: '添加电脑', exact: true })
    await state(page, 'node-enrollment-new', dialog)
    expect(await dialog.getByLabel('电脑名称', { exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    await dialog.getByRole('button', { name: '签发接入码', exact: true }).tap()
    await dialog.getByRole('alert').waitFor()
    await state(page, 'node-enrollment-invalid', dialog)
    await dialog.getByLabel('电脑名称', { exact: true }).fill('QA enrollment')
    await pendingReply(replies, `POST ${enrollmentPath}`, { status: 409, body: { error: 'node-access/name-conflict' } },
      () => dialog.getByRole('button', { name: '签发接入码', exact: true }).tap(),
      () => state(page, 'node-enrollment-pending', dialog))
    await dialog.getByRole('alert').filter({ hasText: '名称已被使用' }).waitFor()
    await state(page, 'node-enrollment-refused', dialog)
    replies.set(`POST ${enrollmentPath}`, { status: 503, body: { error: 'node-access/unavailable' } })
    await dialog.getByRole('button', { name: '签发接入码', exact: true }).tap()
    await dialog.getByRole('alert').filter({ hasText: '无法确认操作是否已完成' }).waitFor()
    await state(page, 'node-enrollment-uncertain', dialog)
    await close(dialog)
    await section.getByRole('button', { name: '添加电脑', exact: true }).tap()
    dialog = page.getByRole('dialog', { name: '添加电脑', exact: true })
    await dialog.getByLabel('已部署电脑', { exact: true }).selectOption(fixture.remoteNodeId)
    await state(page, 'node-enrollment-existing', dialog)
    replies.set(`POST ${enrollmentPath}`, (request) => {
      const data = request.postDataJSON() as Record<string, unknown>
      expect(typeof data.requestId).toBe('string')
      return { body: { nodeId: fixture.remoteNodeId, enrollmentId: data.requestId, revision: 1,
        token: `dsh_enroll_${'A'.repeat(43)}`, expiresAt: '2026-11-20T12:00:00.000Z' } }
    })
    await dialog.getByRole('button', { name: '签发接入码', exact: true }).tap()
    const ticket = page.getByRole('dialog', { name: /一次性接入码$/ })
    await state(page, 'node-ticket-hidden', ticket)
    await ticket.getByRole('button', { name: '显示接入码', exact: true }).tap()
    await state(page, 'node-ticket-revealed', ticket)
    await ticket.getByText('节点启动说明', { exact: true }).tap()
    await state(page, 'node-ticket-setup', ticket)
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('QA clipboard refusal', 'NotAllowedError') },
      } })
    })
    await ticket.getByRole('button', { name: '复制接入码', exact: true }).tap()
    await ticket.getByRole('alert').waitFor()
    await state(page, 'node-ticket-copy-refused', ticket)
    await close(ticket)
    for (const action of ['重新签发', '退出接入', '撤销接入']) {
      await section.getByRole('button', { name: action, exact: true }).first().tap()
      const confirm = page.getByRole('dialog')
      await state(page, `node-${action === '重新签发' ? 'reissue' : action === '退出接入' ? 'detach' : 'revoke'}-confirm`, confirm)
      await close(confirm)
    }
  }, true)
}, timeout)

it('renders each empty-draft maintenance surface before scanning or deleting isolated records', async () => {
  await visit('/archives', async (page, replies) => {
    const preview = 'GET /admin/api/archives/empty-drafts/preview'
    const rootSessionId = 'empty-draft-qa-with-a-long-display-identifier'
    const runtimeId = '33000000-0000-4000-8000-000000000033'
    const candidate = { rootSessionId, runtime: { kind: 'user', id: fixture.adminId, runtimeId },
      creator: { id: fixture.adminId, displayName: 'QA draft owner' }, project: null,
      createdAt: 1, updatedAt: 1, eventCount: 0 }
    replies.set(preview, { body: { cutoff: 1000, candidates: [] } })
    await page.getByRole('button', { name: '清理空白草稿', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: '清理空白草稿', exact: true })
    await state(page, 'empty-drafts-initial', dialog)
    await pendingReply(replies, preview, { body: { cutoff: 1000, candidates: [] } },
      () => dialog.getByRole('button', { name: '重新扫描', exact: true }).tap(),
      () => state(page, 'empty-drafts-scanning', dialog))
    await dialog.getByText('当前没有符合条件的空白草稿', { exact: true }).waitFor()
    await state(page, 'empty-drafts-none', dialog)
    replies.set(preview, { status: 503, body: { error: 'unavailable' } })
    await dialog.getByRole('button', { name: '重新扫描', exact: true }).tap()
    await dialog.getByRole('alert').waitFor()
    await state(page, 'empty-drafts-scan-refused', dialog)
    replies.set(preview, { body: { cutoff: 1000, candidates: [candidate] } })
    await dialog.getByRole('button', { name: '重新扫描', exact: true }).tap()
    await dialog.getByRole('checkbox').filter({ visible: true }).first().check()
    await state(page, 'empty-drafts-selected', dialog)
    await dialog.getByRole('button', { name: '删除选中 1 项', exact: true }).tap()
    const confirmation = page.getByRole('dialog', { name: '删除所选空白草稿？', exact: true })
    await state(page, 'empty-drafts-trash-confirm', confirmation)
    await pendingReply(replies, 'POST /admin/api/archives/empty-drafts/trash', { body: { trashed: [{ rootSessionId, runtimeId }] } },
      () => confirmation.getByRole('button', { name: '删除', exact: true }).tap(),
      () => state(page, 'empty-drafts-trash-pending', confirmation))
    await confirmation.waitFor({ state: 'hidden' })
    await dialog.getByText(/已移入回收站 1 个草稿/).waitFor()
    await state(page, 'empty-drafts-trash-result', dialog)
    await close(dialog)
  })
}, timeout)

it('retains account drafts and explains refused account changes in each active dialog', async () => {
  await visit('/users', async (page, replies) => {
    const account = { id: 2, username: 'qa-account', displayName: 'QA account with a long display name for independent review',
      role: 'user', status: 'active', homePath: '/qa/account', mustChangePassword: false,
      autoReviewEligible: false, port: null, instanceState: 'stopped' }
    replies.set('GET /admin/api/users', { body: [account] })
    for (const operation of ['POST /admin/api/users', 'PATCH /admin/api/users/2',
      'DELETE /admin/api/users/2', 'POST /admin/api/users/2/password']) {
      replies.set(operation, { status: 409, body: { error: 'QA account write was refused; the account remains unchanged.' } })
    }
    await page.reload()
    for (const action of [
      { open: '新建用户', name: 'account-create', submit: '创建用户' },
      { open: '编辑用户', name: 'account-edit', submit: '保存更改' },
      { open: '重置密码', name: 'account-password', submit: '重置密码' },
      { open: '禁用用户', name: 'account-disable', submit: '确认禁用' },
      { open: '删除用户', name: 'account-delete', submit: '确认删除' },
    ]) {
      await page.getByRole('button', { name: action.open, exact: true }).filter({ visible: true }).first().tap()
      const dialog = page.getByRole('dialog')
      if (action.name === 'account-create') {
        await dialog.getByLabel('用户名', { exact: true }).fill('qa-created')
        await dialog.getByLabel('初始密码', { exact: true }).fill('QA-only-password')
      }
      if (action.name === 'account-edit') await dialog.getByLabel('显示名', { exact: true }).fill('Changed QA display name')
      if (action.name === 'account-password') await dialog.getByLabel('新密码', { exact: true }).fill('QA-only-replacement')
      await state(page, `${action.name}-draft`, dialog)
      const operation = action.name === 'account-create' ? 'POST /admin/api/users'
        : action.name === 'account-password' ? 'POST /admin/api/users/2/password'
          : action.name === 'account-delete' ? 'DELETE /admin/api/users/2' : 'PATCH /admin/api/users/2'
      await pendingReply(replies, operation, refusal,
        () => dialog.getByRole('button', { name: action.submit, exact: true }).tap(),
        () => state(page, `${action.name}-pending`, dialog))
      await dialog.getByRole('alert').waitFor()
      await state(page, `${action.name}-refused`, dialog)
      await close(dialog)
    }
  })
}, timeout)

it('exposes the full SSH credential, sharing and deletion dialogs', async () => {
  await visit('/ssh', async (page) => {
    await page.getByRole('button', { name: '注册目标', exact: true }).tap()
    let dialog = page.getByRole('dialog', { name: '注册 SSH 目标', exact: true })
    await state(page, 'ssh-register-full', dialog)
    await dialog.getByRole('button', { name: '保存', exact: true }).tap()
    await dialog.getByRole('alert').waitFor()
    await state(page, 'ssh-register-invalid', dialog)
    await close(dialog)
    for (const [action, name] of [['编辑', 'ssh-edit-full'], ['项目共享', 'ssh-sharing'], ['删除', 'ssh-delete-confirm']] as const) {
      await page.getByRole('button', { name: action, exact: true }).filter({ visible: true }).first().tap()
      dialog = page.getByRole('dialog')
      await state(page, name, dialog)
      await close(dialog)
    }
  })
}, timeout)

it.each(['sharing', 'deletion'] as const)('keeps SSH %s pending and refused outcomes inside the active dialog', async (operation) => {
  await visit('/ssh', async (page, replies) => {
    await page.getByRole('button', { name: operation === 'sharing' ? '项目共享' : '删除', exact: true }).filter({ visible: true }).first().tap()
    const dialog = page.getByRole('dialog')
    await pendingReply(replies, `POST /admin/api/ssh-targets/${operation === 'sharing' ? 'share' : 'mutate'}`, refusal,
      () => operation === 'sharing' ? dialog.locator('.switchControl').first().tap()
        : dialog.getByRole('button', { name: '删除', exact: true }).tap(),
      () => state(page, `ssh-${operation}-pending`, dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, `ssh-${operation}-refused`, dialog)
  })
}, timeout)

it('keeps a document trash refusal visible in its nested confirmation', async () => {
  await visit('/documents', async (page, replies) => {
    await page.getByRole('button', { name: '查看详情', exact: true }).filter({ visible: true }).first().tap()
    const detail = page.getByRole('dialog')
    await detail.getByRole('button', { name: '移入回收站', exact: true }).tap()
    const confirm = page.getByRole('dialog', { name: '确认移入回收站', exact: true })
    await state(page, 'document-trash-confirm', confirm)
    await pendingReply(replies, 'DELETE /admin/api/documents/11111111-1111-4111-8111-111111111111', refusal,
      () => confirm.getByRole('button', { name: '移入回收站', exact: true }).tap(),
      () => state(page, 'document-trash-pending', confirm))
    await confirm.getByRole('alert').waitFor()
    await state(page, 'document-trash-refused', confirm)
  })
}, timeout)

it.each(['project-delete', 'webhook-delete', 'steward-grant'] as const)(
  'keeps %s confirmation, pending and refusal states visible', async (name) => {
    const path = name === 'project-delete' ? `/projects/${fixture.projectId}` : name === 'webhook-delete' ? '/webhooks' : '/steward'
    await visit(path, async (page, replies) => {
      if (name === 'steward-grant') await page.locator('.switchControl').filter({ visible: true }).first().tap()
      else await page.getByRole('button', { name: name === 'project-delete' ? '删除项目' : '删除', exact: true }).filter({ visible: true }).first().tap()
      const dialog = page.getByRole('dialog')
      await state(page, `${name}-confirm`, dialog)
      const request = name === 'project-delete' ? `DELETE /admin/api/projects/${fixture.projectId}`
        : name === 'webhook-delete' ? 'POST /admin/api/webhook-endpoints/mutate' : 'POST /admin/api/steward/permissions'
      await pendingReply(replies, request, refusal,
        () => dialog.locator('.dialogFooter button').last().tap(),
        () => state(page, `${name}-pending`, dialog))
      await dialog.getByRole('alert').waitFor()
      await state(page, `${name}-refused`, dialog)
    })
  }, timeout,
)

it('retains the project creation form while submission is pending or refused', async () => {
  await visit('/projects', async (page, replies) => {
    await page.getByRole('button', { name: '新建项目', exact: true }).first().tap()
    const dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
    await dialog.getByRole('textbox').first().fill('QA project creation')
    await state(page, 'project-create-draft', dialog)
    await pendingReply(replies, 'POST /admin/api/projects', refusal,
      () => dialog.locator('.dialogFooter button').last().tap(),
      () => state(page, 'project-create-pending', dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, 'project-create-refused', dialog)
  })
}, timeout)

it('exposes terminal closure confirmation and the unconfirmed page result', async () => {
  await visit('/terminals', async (page, replies) => {
    await page.getByRole('combobox', { name: '终端运行范围', exact: true }).selectOption(`user:${fixture.adminId}`)
    await page.getByRole('button', { name: '关闭终端', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: '关闭终端', exact: true })
    await state(page, 'terminal-close-confirm', dialog)
    await pendingReply(replies, 'POST /admin/api/terminals/close', refusal,
      () => dialog.locator('.dialogFooter button').last().tap(),
      () => state(page, 'terminal-close-pending', dialog))
    await dialog.waitFor({ state: 'hidden' })
    const section = page.locator('section', { has: page.getByRole('combobox', { name: '终端运行范围', exact: true }) })
    await section.getByRole('alert').waitFor()
    await state(page, 'terminal-close-unconfirmed', section)
  })
}, timeout)

it('keeps the Webhook delivery list and redispatch failure visible within its dialog', async () => {
  await visit('/webhooks', async (page, replies) => {
    replies.set('GET /admin/api/webhook-deliveries', { body: { items: [{ id: 'qa-receipt',
      deliveryId: 'LongWebhookDeliveryIdentifierWithoutBreaks012345678901234567890123456789', configurationRevision: '1',
      state: 'rejected', sessionId: null, errorCode: 'policy-denied', receivedAt: '2026-11-16T00:00:00Z' }], nextCursor: null } })
    await page.getByRole('button', { name: '投递记录', exact: true }).tap()
    const dialog = page.getByRole('dialog')
    await state(page, 'webhook-deliveries', dialog)
    await pendingReply(replies, 'POST /admin/api/webhook-deliveries/redispatch', refusal,
      () => dialog.getByRole('button', { name: '重跑', exact: true }).tap(),
      () => state(page, 'webhook-redispatch-pending', dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, 'webhook-redispatch-refused', dialog)
  })
}, timeout)

it('shows the responding Gateway release alongside the database migration version in one deployment read', async () => {
  await visit('/deployment', async (page, replies) => {
    const releaseId = 'coharness-browser-fixture'
    const state = await (await page.request.get(fixture.base + '/admin/api/deployment')).json() as DeploymentState
    let reads = 0, individualReads = 0
    replies.set('GET /admin/api/deployment/overview', async (request) => {
      const original = await (await page.request.get(request.url())).json() as { sections: Record<string, unknown> }
      reads++
      return { body: { sections: { ...original.sections, deployment: { ok: true, value: {
        ...state, releaseId, migrations: { current: 148, applied: [148], pending: [], drifted: [] },
      } } } } }
    })
    replies.set('GET /admin/api/deployment', () => { individualReads++; return { body: state } })
    await page.reload()
    const release = page.getByText('提供部署状态的 Gateway 版本')
    const migrations = page.getByText('数据库迁移版本 148，已应用 1 个迁移。', { exact: true })
    await migrations.waitFor()
    expect(await release.innerText()).toContain(releaseId)
    expect(reads).toBe(1)
    expect(individualReads).toBe(0)
    await compareOrRefreshGolden(join(dirname(fileURLToPath(import.meta.url)), 'snapshots/admin-dialog-states/deployment-release.expected.md'),
      [await release.innerText(), await migrations.innerText()].join('\n'), webSnapshotMode())
  })
})

it('reviews deployment-mode blockers and the independent disable confirmation', async () => {
  await visit('/deployment', async (page, replies) => {
    const section = page.locator('section', { has: page.getByRole('heading', { name: '部署模式', exact: true }) })
    await section.getByRole('checkbox', { name: '启用多电脑', exact: true }).locator('..').tap()
    replies.set('GET /admin/api/deployment/topology/preflight', { body: { canDisable: false, blockingCount: 1,
      computers: [{ nodeId: fixture.remoteNodeId, name: 'QA attached computer with retained Runtimes', state: 'managed', activeRuntimes: 2 }] } })
    await section.getByRole('button', { name: '保存部署模式', exact: true }).tap()
    await section.getByRole('status').filter({ hasText: '仍有 1 台电脑' }).waitFor()
    await state(page, 'topology-disable-blocked', section)
    replies.set('GET /admin/api/deployment/topology/preflight', { body: { canDisable: true, blockingCount: 0, computers: [] } })
    await section.getByRole('button', { name: '保存部署模式', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: '关闭多电脑模式', exact: true })
    await state(page, 'topology-disable-confirm', dialog)
    await pendingReply(replies, 'PUT /admin/api/deployment/topology', refusal,
      () => dialog.getByRole('button', { name: '确认关闭', exact: true }).tap(),
      () => state(page, 'topology-disable-pending', dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, 'topology-disable-refused', dialog)
  }, true)
}, timeout)

function nodeConnectionFixture(replies: Map<string, ReplySource>): { deployment: DeploymentContext; connection: NodeConnectionView } {
  const deployment: DeploymentContext = { mode: 'multi', revision: '1',
    entry: { nodeId: fixture.nodeId, name: 'QA non-primary computer' },
    primary: { nodeId: fixture.remoteNodeId, name: 'QA primary computer', origin: 'https://qa-primary.example.invalid' },
    scope: 'local', role: 'computer', refreshAfterMs: 1000, legacyMigrationRequired: false }
  const connection: NodeConnectionView = { nodeId: fixture.nodeId, revision: 0, configured: false,
    centerUrl: null, localGatewayUrl: fixture.base, enrollmentPending: false, originReady: false,
    service: 'qa-isolated-node-service', connectionState: 'independent' }
  replies.set('GET /account/api/deployment/context', { body: deployment })
  replies.set('GET /admin/api/deployment/node-connection', { body: connection })
  replies.set('POST /admin/api/deployment/node-connection', refusal)
  replies.set('POST /admin/api/deployment/configuration', refusal)
  return { deployment, connection }
}

it('reads the non-primary connection wizard through loading, refusal and every connection state', async () => {
  await visit('/deployment', async (page, replies) => {
    const { deployment, connection } = nodeConnectionFixture(replies)
    const section = page.locator('section', { has: page.getByRole('heading', { name: '连接到主入口', exact: true }) })
    const read = 'GET /admin/api/deployment/node-connection'
    await pendingReply(replies, read, { body: connection },
      async () => { await page.reload({ waitUntil: 'domcontentloaded' }) },
      async () => {
        await section.getByText('正在读取部署设置', { exact: true }).waitFor()
        await state(page, 'node-connection-loading', section)
      })
    await section.getByLabel('中心地址', { exact: true }).waitFor()
    expect(await section.getByLabel('中心地址', { exact: true }).inputValue()).toBe(deployment.primary!.origin)
    expect(await section.getByRole('button', { name: '保存接入配置', exact: true }).isDisabled()).toBe(true)
    expect(await section.getByRole('button', { name: '启动接入服务', exact: true }).isDisabled()).toBe(true)
    await state(page, 'node-connection-unconfigured', section)
    replies.set(read, { status: 503, body: { error: 'QA connection settings unavailable' } })
    await page.reload()
    await section.getByRole('alert').filter({ hasText: '未能读取部署设置，请重新读取' }).waitFor()
    await state(page, 'node-connection-read-refused', section)
    for (const [connectionState, label] of [
      ['pending', '待接入'], ['disconnected', '未连接'], ['connected', '已连接'], ['revoked', '接入已撤销'],
    ] as const) {
      replies.set(read, { body: { ...connection, revision: 1, configured: true, centerUrl: deployment.primary!.origin,
        originReady: true, enrollmentPending: connectionState === 'pending', connectionState } satisfies NodeConnectionView })
      await page.reload()
      await section.getByText(`已保存本机接入配置 · ${label}`, { exact: true }).waitFor()
      expect(await section.getByRole('alert').count()).toBe(0)
      expect(await section.getByRole('button', { name: '启动接入服务', exact: true }).isDisabled()).toBe(connectionState === 'connected')
      await state(page, `node-connection-${connectionState}`, section)
    }
  })
}, timeout)

it('preserves non-primary enrollment drafts on refusal and clears only the saved one-time code', async () => {
  await visit('/deployment', async (page, replies) => {
    const { connection } = nodeConnectionFixture(replies)
    await page.reload()
    const section = page.locator('section', { has: page.getByRole('heading', { name: '连接到主入口', exact: true }) })
    const center = section.getByLabel('中心地址', { exact: true })
    const code = section.getByLabel('一次性接入码', { exact: true })
    const save = section.getByRole('button', { name: '保存接入配置', exact: true })
    const centerUrl = 'https://qa-long-primary-address-for-responsive-acceptance.example.invalid'
    const enrollmentToken = 'qa-only-enrollment-token-012345678901234567890123456789'
    await center.fill('')
    await code.fill(enrollmentToken)
    expect(await save.isDisabled()).toBe(true)
    await state(page, 'node-connection-missing-center', section)
    await center.fill(centerUrl)
    expect(await code.getAttribute('type')).toBe('password')
    expect(await save.isEnabled()).toBe(true)
    await state(page, 'node-connection-long-draft', section)
    const writes: unknown[] = []
    for (const [failure, message] of [
      ['node-connection-primary-mismatch', '中心地址或接入码与这台电脑不匹配，请到主入口重新核对'],
      ['node-connection-already-connected', '这台电脑已有活动接入，请先退出原接入再更换配置'],
      ['node-connection-new-enrollment-required', '请先在主入口为这台电脑重新签发接入码，并保存新的接入配置'],
      ['qa-write-refused', '操作未完成，请读取当前状态后再操作'],
    ] as const) {
      replies.set('POST /admin/api/deployment/node-connection', (request) => {
        writes.push(request.postDataJSON())
        return { status: 409, body: { error: failure, code: failure } }
      })
      await save.tap()
      await section.getByRole('alert').filter({ hasText: message }).waitFor()
      expect(writes.at(-1)).toEqual({ action: 'save', values: { revision: 0, centerUrl, enrollmentToken } })
      expect(await center.inputValue()).toBe(centerUrl)
      expect(await code.inputValue()).toBe(enrollmentToken)
      await state(page, failure === 'qa-write-refused' ? 'node-connection-save-refused' : failure, section)
    }
    await pendingReply(replies, 'POST /admin/api/deployment/node-connection', { body: { ...connection,
      revision: 1, configured: true, centerUrl, enrollmentPending: true, connectionState: 'pending' } satisfies NodeConnectionView },
    () => save.tap(), async () => {
      expect(await center.isDisabled()).toBe(true)
      expect(await code.isDisabled()).toBe(true)
      await state(page, 'node-connection-save-pending', section)
    })
    await section.getByRole('status').filter({ hasText: '接入配置已保存，接入码已从页面清除' }).waitFor()
    expect(await code.inputValue()).toBe('')
    expect(await center.inputValue()).toBe(centerUrl)
    expect(await save.isDisabled()).toBe(true)
    expect(await section.getByRole('button', { name: '启动接入服务', exact: true }).isDisabled()).toBe(true)
    await state(page, 'node-connection-saved-origin-required', section)
  })
}, timeout)

it('adds the primary origin only to the local draft and keeps unavailable connection drafts', async () => {
  await visit('/deployment', async (page, replies) => {
    const { deployment, connection } = nodeConnectionFixture(replies)
    const response = await page.request.get(`${fixture.base}/admin/api/deployment/configuration`)
    expect(response.ok()).toBe(true)
    const configuration = await response.json() as NodeConfigurationView
    replies.set('GET /admin/api/deployment/node-connection', { body: { ...connection, revision: 1, configured: true,
      centerUrl: deployment.primary!.origin, enrollmentPending: true, connectionState: 'pending' } satisfies NodeConnectionView })
    const section = page.locator('section', { has: page.getByRole('heading', { name: '连接到主入口', exact: true }) })
    const addOrigin = section.getByRole('button', { name: '将主入口加入本机配置草稿', exact: true })
    const writes: string[] = []
    page.on('request', (request) => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
    await pendingReply(replies, 'GET /admin/api/deployment/configuration', { body: configuration },
      async () => { await page.reload({ waitUntil: 'domcontentloaded' }) }, async () => {
        await addOrigin.tap()
        await section.getByRole('status').filter({ hasText: '本机配置尚未准备好或正在应用，请等待后重试' }).waitFor()
        await state(page, 'node-connection-origin-not-ready', section)
      })
    const origins = page.getByLabel('公开访问地址', { exact: true })
    await origins.waitFor()
    const original = await origins.inputValue()
    await addOrigin.tap()
    await section.getByRole('status').filter({ hasText: '主入口来源已加入草稿，请核对、保存并应用配置' }).waitFor()
    expect(await origins.inputValue()).toBe([...new Set([...original.split(',').map(value => value.trim()), deployment.primary!.origin])].join(','))
    await addOrigin.tap()
    expect((await origins.inputValue()).split(',').filter(origin => origin === deployment.primary!.origin)).toHaveLength(1)
    await state(page, 'node-connection-origin-added', section)
    const settings = page.locator('section', { has: origins })
    await settings.getByLabel('筛选节点设置', { exact: true }).fill('HGW_PUBLIC_ORIGINS')
    await state(page, 'node-connection-local-origin-draft', settings)
    await section.getByLabel('一次性接入码', { exact: true }).fill('qa-retained-unavailable-code')
    replies.set('GET /account/api/deployment/context', { body: { ...deployment, mode: 'single', revision: '2',
      primary: null, role: 'standalone' } satisfies DeploymentContext })
    await section.getByRole('alert').filter({ hasText: '部署模式已变化，接入配置草稿仍保留' }).waitFor()
    expect(await section.getByLabel('一次性接入码', { exact: true }).inputValue()).toBe('qa-retained-unavailable-code')
    expect(await section.getByLabel('中心地址', { exact: true }).inputValue()).toBe(deployment.primary!.origin)
    expect(await section.getByLabel('一次性接入码', { exact: true }).isDisabled()).toBe(true)
    expect(await addOrigin.isDisabled()).toBe(true)
    expect(await section.getByRole('button', { name: '保存接入配置', exact: true }).isDisabled()).toBe(true)
    expect(await section.getByRole('button', { name: '启动接入服务', exact: true }).isDisabled()).toBe(true)
    expect(writes).toEqual([])
    await state(page, 'node-connection-mode-unavailable-draft', section)
  })
}, timeout)

it('shows the non-primary service start request, refusal and connected result without starting a host service', async () => {
  await visit('/deployment', async (page, replies) => {
    const { deployment, connection } = nodeConnectionFixture(replies)
    const ready: NodeConnectionView = { ...connection, revision: 1, configured: true,
      centerUrl: deployment.primary!.origin, originReady: true, enrollmentPending: true, connectionState: 'pending' }
    replies.set('GET /admin/api/deployment/node-connection', { body: ready })
    await page.reload()
    const section = page.locator('section', { has: page.getByRole('heading', { name: '连接到主入口', exact: true }) })
    const start = section.getByRole('button', { name: '启动接入服务', exact: true })
    await start.waitFor()
    expect(await start.isEnabled()).toBe(true)
    await state(page, 'node-connection-start-ready', section)
    const requests: unknown[] = []
    const capture = (request: Request): void => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/admin/api/deployment/node-connection') requests.push(request.postDataJSON())
    }
    page.on('request', capture)
    try {
      await pendingReply(replies, 'POST /admin/api/deployment/node-connection', { status: 503,
        body: { error: 'node-connection-service-start-failed', code: 'node-connection-service-start-failed' } },
      () => start.tap(), async () => {
        expect(await start.isDisabled()).toBe(true)
        await state(page, 'node-connection-start-pending', section)
      })
      await section.getByRole('alert').filter({ hasText: '未能启动接入服务，请检查已安装的服务和本机日志' }).waitFor()
      expect(await start.isEnabled()).toBe(true)
      await state(page, 'node-connection-start-refused', section)
      replies.set('POST /admin/api/deployment/node-connection', { body: { ...ready, connectionState: 'connected', enrollmentPending: false } satisfies NodeConnectionView })
      await start.tap()
      await section.getByRole('status').filter({ hasText: '已请求启动服务，请到主入口检查连接状态' }).waitFor()
      await section.getByText('已保存本机接入配置 · 已连接', { exact: true }).waitFor()
      expect(await start.isDisabled()).toBe(true)
      expect(requests).toEqual([{ action: 'start' }, { action: 'start' }])
      await state(page, 'node-connection-start-succeeded', section)
    } finally { page.off('request', capture) }
  })
}, timeout)

it('reviews project migration and historical-copy evidence using isolated protocol responses', async () => {
  await visit('/deployment', async (page, replies) => {
    const prefix = '/admin/api/deployment/project-content-migrations'
    const project = `${prefix}/${fixture.projectId}`
    const section = page.locator('section', { has: page.getByRole('heading', { name: '项目内容迁移', exact: true }) })
    const initial = { nodeId: fixture.nodeId, runtimeId, projectId: fixture.projectId, generation: 0, storage: 'shared',
      sourceRetirement: null, snapshot: null, sourceRevision: '1', blockers: ['prepare-required'], missingAdapters: [],
      canPrepare: true, canPublish: false }
    const prepared = { ...initial, blockers: [], canPublish: true,
      snapshot: { id: '44000000-0000-4000-8000-000000000044', jobId: '55000000-0000-4000-8000-000000000055', sourceRevision: '1' } }
    replies.set(`GET ${prefix}`, { body: { items: [{ id: fixture.projectId, name: 'QA collaboration project migration' }], next: null } })
    replies.set(`GET ${project}`, { body: initial })
    await section.getByRole('button', { name: '选择项目', exact: true }).tap()
    await section.getByRole('combobox', { name: '本机项目', exact: true }).selectOption(String(fixture.projectId))
    await state(page, 'migration-project-selected', section)
    await section.getByRole('button', { name: '检查项目', exact: true }).tap()
    await section.getByRole('button', { name: '准备副本', exact: true }).waitFor()
    await state(page, 'migration-prepare-required', section)
    await pendingReply(replies, `POST ${project}/prepare`, { body: prepared },
      () => section.getByRole('button', { name: '准备副本', exact: true }).tap(),
      () => state(page, 'migration-preparing', section))
    await section.getByRole('button', { name: '切换项目存储', exact: true }).waitFor()
    await state(page, 'migration-prepared', section)
    await section.getByRole('button', { name: '切换项目存储', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: '切换项目存储', exact: true })
    await state(page, 'migration-publish-confirm', dialog)
    await pendingReply(replies, `POST ${project}/publish`, refusal,
      () => dialog.getByRole('button', { name: '确认切换', exact: true }).tap(),
      () => state(page, 'migration-publish-pending', dialog))
    await dialog.waitFor({ state: 'hidden' })
    await section.getByRole('alert').waitFor()
    await state(page, 'migration-publish-refused', section)
    replies.set(`GET ${project}`, { body: { ...prepared, storage: 'node', sourceRetirement: 'retiring', canPrepare: false, canPublish: false } })
    await section.getByRole('button', { name: '检查项目', exact: true }).tap()
    await section.getByRole('button', { name: '查看历史副本', exact: true }).waitFor()
    await state(page, 'migration-local-storage', section)
    const report = { projectId: fixture.projectId, nodeId: fixture.nodeId, runtimeId, writerEpoch: '1', sourceRetirement: 'retiring',
      knownOrigin: true, originalClusterStillServing: false, reviewId: null, retainedRelations: ['session_events'], outstanding: ['policy'] }
    replies.set(`GET ${project}/retirement`, { body: report })
    await section.getByRole('button', { name: '查看历史副本', exact: true }).tap()
    await section.getByRole('textbox', { name: '保留策略 SHA-256', exact: true }).fill('a'.repeat(64))
    await state(page, 'migration-retirement-draft', section)
    const review = { ...report, reviewId: '66000000-0000-4000-8000-000000000066', retainedRelations: [], outstanding: [] }
    await pendingReply(replies, `POST ${project}/retirement/review`, { body: review },
      () => section.getByRole('button', { name: '开始核验', exact: true }).tap(),
      () => state(page, 'migration-retirement-pending', section))
    await section.getByRole('button', { name: '登记处置完成', exact: true }).waitFor()
    await state(page, 'migration-retirement-reviewed', section)
    replies.set(`POST ${project}/retirement/finalize`, { body: { ...review, sourceRetirement: 'retired' } })
    await section.getByRole('button', { name: '登记处置完成', exact: true }).tap()
    await section.getByText('历史副本处置已核验。', { exact: true }).waitFor()
    await state(page, 'migration-retirement-finalized', section)
  }, true)
}, timeout)

it('reviews backup configuration variants and deployment confirmations without restoring host data', async () => {
  await visit('/deployment', async (page, replies) => {
    const configuration = await (await page.request.get(`${fixture.base}/admin/api/deployment/configuration`)).json() as NodeConfigurationView
    const deployment = await (await page.request.get(`${fixture.base}/admin/api/deployment`)).json() as DeploymentState
    const backup = { id: 'qa-backup', path: '/qa/retained-backup-with-long-independent-name.tar', format: 'tar',
      migrationVersion: 1, writeEpoch: '1', sizeBytes: 1024, sha256: 'a'.repeat(64), status: 'verified',
      createdBy: fixture.adminId, createdAt: '2026-11-16T00:00:00.000Z', verifiedAt: '2026-11-16T00:01:00.000Z',
      restoredAt: null, error: null, managedSnapshot: { version: 1, roots: [], files: [], directories: [], absent: [] } }
    replies.set('GET /admin/api/backups', { body: { backups: [backup] } })
    replies.set('GET /admin/api/deployment', { body: { ...deployment, mode: 'maintenance', writersQuiesced: true } })
    await page.reload()
    const preview = page.getByRole('dialog', { name: '备份中的节点配置', exact: true })
    for (const variant of ['empty', 'ready', 'incompatible'] as const) {
      replies.set('POST /admin/api/backups/node-configuration', { body: { backupId: backup.id, configFile: null, appliedRevision: 1,
        values: variant === 'empty' ? null : configuration.effective,
        incompatibleFields: variant === 'incompatible' ? ['HGW_STATE_ROOT', 'HGW_PROJECTS_ROOT'] : [] } })
      await page.getByRole('button', { name: '查看备份配置', exact: true }).tap()
      await state(page, `backup-configuration-${variant}`, preview)
      await close(preview)
    }
    for (const [name, title, confirm, path] of [
      ['restore', '请求恢复备份', '登记恢复请求', '/admin/api/deployment/restore'],
      ['exit-maintenance', '退出维护窗口', '退出维护', '/admin/api/deployment/maintenance'],
    ] as const) {
      await page.getByRole('button', { name: name === 'restore' ? '请求恢复' : title, exact: true }).tap()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await state(page, `deployment-${name}-confirm`, dialog)
      await pendingReply(replies, `POST ${path}`, refusal,
        () => dialog.getByRole('button', { name: confirm, exact: true }).tap(), async () => {
          await dialog.waitFor({ state: 'hidden' })
          await state(page, `deployment-${name}-pending`, page.getByRole('main'))
        })
      replies.set('GET /admin/api/deployment', refusal)
      await page.getByRole('alert').filter({ hasText: 'QA write refused' }).waitFor()
      await state(page, `deployment-${name}-refused`, page.getByRole('main'))
    }
  })
}, timeout)

it('reviews held desktop grants and unavailable-resource cleanup without releasing a real desktop', async () => {
  await visit('/desktops', async (page, replies) => {
    const resource = { resourceKey: 'qa-computer/qa-desktop', node: 'qa-computer', desktop: 'qa-desktop', fencingSeq: 1,
      queueSeq: 1, state: 'unavailable', stateNote: 'QA desktop waiting for holder confirmation', updatedAt: 1_794_873_600_000 }
    const holderJson = JSON.stringify({ organization: 'qa', runtime: { kind: 'user', id: fixture.adminId, generation: 1 },
      user: { id: fixture.adminId, username: 'QA long desktop holder username' } })
    const grant = { grantId: 'qa-held-grant', resourceKey: resource.resourceKey, fencing: 1, holderKey: 'qa-holder', holderJson,
      requestId: 'qa-request', state: 'held', reason: null, acquiredAt: resource.updatedAt, heartbeatAt: resource.updatedAt,
      stoppingAt: null, releasedAt: null }
    replies.set('GET /admin/api/desktops', { body: { resources: [resource] } })
    replies.set('GET /admin/api/desktops/detail', { body: { resource, grants: [grant], queue: [{ queueId: 'qa-queue',
      resourceKey: resource.resourceKey, position: 1, holderKey: 'qa-next-holder', holderJson, requestId: 'qa-next-request',
      state: 'queued', queuedAt: resource.updatedAt, settledAt: null, grantId: null }] } })
    await page.reload()
    await page.getByRole('button', { name: '详情', exact: true }).filter({ visible: true }).tap()
    await page.getByRole('button', { name: '撤权', exact: true }).waitFor()
    await state(page, 'desktop-grants-and-queue', page.getByRole('main'))
    for (const [name, action, title, confirm] of [
      ['revoke', '撤权', '撤权桌面授权', '撤权'],
      ['clear', '清理不可用状态', '清理不可用桌面', '清理'],
    ] as const) {
      await page.getByRole('button', { name: action, exact: true }).tap()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await state(page, `desktop-${name}-confirm`, dialog)
      await pendingReply(replies, 'POST /admin/api/desktops/actions', refusal,
        () => dialog.getByRole('button', { name: confirm, exact: true }).tap(),
        () => state(page, `desktop-${name}-pending`, dialog))
      await dialog.waitFor({ state: 'hidden' })
      await page.getByRole('alert').filter({ hasText: 'QA write refused' }).waitFor()
      await state(page, `desktop-${name}-refused`, page.getByRole('main'))
    }
  })
}, timeout)

it('reviews project document ownership, restore and single or batch purge states with isolated refusals', async () => {
  await visit('/documents', async (page, replies) => {
    const id = '11111111-1111-4111-8111-111111111111'
    const original = await (await page.request.get(`${fixture.base}/admin/api/documents/${id}`)).json() as AdminDocumentDetail
    const project = await (await page.request.get(`${fixture.base}/admin/api/projects/${fixture.projectId}`)).json() as ProjectDetail
    const document = { ...original.document, scope: { kind: 'project', id: fixture.projectId, label: 'QA project document' } }
    replies.set('GET /admin/api/documents', { body: { documents: [document] } })
    replies.set(`GET /admin/api/documents/${id}`, { body: { ...original, document } })
    replies.set(`GET /admin/api/projects/${fixture.projectId}`, { body: { ...project, members: [{ userId: fixture.adminId }] } })
    await page.reload()
    await page.getByRole('button', { name: '查看详情', exact: true }).filter({ visible: true }).first().tap()
    const detail = page.getByRole('dialog')
    await expect.poll(() => detail.getByRole('combobox', { name: '所有者', exact: true }).isEnabled()).toBe(true)
    await state(page, 'document-owner-draft', detail)
    await pendingReply(replies, `POST /admin/api/documents/${id}/ownership`, refusal,
      () => detail.getByRole('button', { name: '转移所有权', exact: true }).tap(),
      () => state(page, 'document-owner-pending', detail))
    await detail.getByRole('alert').waitFor()
    await state(page, 'document-owner-refused', detail)
    await close(detail)
    const trashed = { ...document, state: 'trash' }
    replies.set('GET /admin/api/documents', { body: { documents: [trashed] } })
    replies.set(`GET /admin/api/documents/${id}`, { body: { ...original, document: trashed } })
    await page.getByRole('button', { name: '刷新', exact: true }).tap()
    await page.getByRole('button', { name: '查看详情', exact: true }).filter({ visible: true }).first().tap()
    await state(page, 'document-trash-detail', detail)
    await pendingReply(replies, 'POST /admin/api/documents/actions', refusal,
      () => detail.getByRole('button', { name: '恢复', exact: true }).tap(),
      () => state(page, 'document-restore-pending', detail))
    await detail.getByRole('alert').waitFor()
    await state(page, 'document-restore-refused', detail)
    await detail.getByRole('button', { name: '永久清理', exact: true }).tap()
    const single = page.getByRole('dialog', { name: '永久清理文档？', exact: true })
    await state(page, 'document-purge-confirm', single)
    await pendingReply(replies, 'POST /admin/api/documents/actions', refusal,
      () => single.getByRole('button', { name: '永久清理', exact: true }).tap(), async () => {
        await single.waitFor({ state: 'hidden' })
        await state(page, 'document-purge-pending', detail)
      })
    await detail.getByRole('alert').waitFor()
    await state(page, 'document-purge-refused', detail)
    await close(detail)
    await page.getByRole('checkbox').filter({ visible: true }).first().locator('..').tap()
    const toolbar = page.getByRole('toolbar', { name: '批量文档操作', exact: true })
    await state(page, 'document-batch-selected', toolbar)
    await toolbar.getByRole('button', { name: '永久清理', exact: true }).tap()
    const batch = page.getByRole('dialog', { name: '永久清理所选文档？', exact: true })
    await state(page, 'document-batch-purge-confirm', batch)
    await pendingReply(replies, 'POST /admin/api/documents/actions', refusal,
      () => batch.getByRole('button', { name: '永久清理', exact: true }).tap(), async () => {
        await batch.waitFor({ state: 'hidden' })
        await state(page, 'document-batch-purge-pending', toolbar)
      })
    await page.getByRole('alert').waitFor()
    await state(page, 'document-batch-purge-refused', page.getByRole('main'))
  })
}, timeout)

it('reviews named-tunnel credential cleanup without contacting a tunnel provider', async () => {
  await visit('/deployment', async (page, replies) => {
    const initial = await (await page.request.get(`${fixture.base}/admin/api/tunnel`)).json() as TunnelAccessView
    replies.set('GET /admin/api/tunnel', { body: { ...initial, mode: 'named', apiTokenConfigured: true,
      hostname: 'long-reviewed-application-name.example.invalid', domain: 'example.invalid' } })
    await page.reload()
    const section = page.locator('section', { has: page.getByRole('heading', { name: '公网访问', exact: true }) })
    await section.getByRole('button', { name: '清除配置', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: '清除隧道配置', exact: true })
    await state(page, 'tunnel-clear-confirm', dialog)
    await pendingReply(replies, 'POST /admin/api/tunnel/actions', refusal,
      () => dialog.getByRole('button', { name: '确认清除', exact: true }).tap(), async () => {
        await dialog.waitFor({ state: 'hidden' })
        await state(page, 'tunnel-clear-pending', section)
      })
    await section.getByRole('alert').waitFor()
    await state(page, 'tunnel-clear-refused', section)
  })
}, timeout)

it('keeps the complete Webhook create and edit forms reachable through validation and pending writes', async () => {
  await visit('/webhooks', async (page, replies) => {
    await page.getByRole('button', { name: '注册端点', exact: true }).tap()
    const dialog = page.getByRole('dialog')
    await state(page, 'webhook-register-full', dialog)
    await dialog.getByRole('button', { name: '保存', exact: true }).tap()
    await dialog.getByRole('alert').waitFor()
    await state(page, 'webhook-register-invalid', dialog)
    await dialog.getByRole('combobox', { name: '运行时类型', exact: true }).selectOption('project')
    await state(page, 'webhook-project-visibility', dialog)
    await close(dialog)
    await page.getByRole('button', { name: '编辑', exact: true }).tap()
    await expect.poll(() => dialog.getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(true)
    await state(page, 'webhook-edit-full', dialog)
    await pendingReply(replies, 'POST /admin/api/webhook-endpoints/update', refusal,
      () => dialog.getByRole('button', { name: '保存', exact: true }).tap(),
      () => state(page, 'webhook-edit-pending', dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, 'webhook-edit-refused', dialog)
  })
}, timeout)

const peerIds = { policy: '33333333-3333-4333-8333-333333333333', point: '44444444-4444-4444-8444-444444444444',
  attempt: '55555555-5555-4555-8555-555555555555', replacement: '66666666-6666-4666-8666-666666666666',
  volume: '77777777-7777-4777-8777-777777777777' }
const peerRefusal: Reply = { status: 409, body: { error: 'peer-backup/revision-conflict' } }

async function peerPage(page: Page, replies: Map<string, ReplySource>, kind: 'project' | 'personal' = 'project'): Promise<Locator> {
  const deployment = await (await page.request.get(`${fixture.base}/admin/api/deployment`)).json() as DeploymentState
  const nodes = [fixture.nodeId, fixture.remoteNodeId, peerIds.replacement].map((nodeId, index) => ({ nodeId,
    name: `QA computer ${index + 1} with a long independent name`, status: 'active', lastHeartbeatAt: null,
    heartbeatAgeMs: null, maintenanceAppliedEpoch: '1', inflightWrites: 0, activeRuntimes: 0, quiesced: false }))
  replies.set('GET /admin/api/deployment', { body: { ...deployment, nodes } })
  replies.set('GET /admin/api/peer-backups', { body: { localWorkerConfigured: true, recoveryConfigured: true, policies: [{
    policyId: peerIds.policy, scopeId: peerIds.policy, scopeKind: kind, sourceNodeId: fixture.nodeId,
    targetNodeId: fixture.remoteNodeId, revision: 1, enabled: true, tier: 'important', quotaBytes: 1_073_741_824,
    appendFingerprint: 'a'.repeat(64), recoveryFingerprint: 'b'.repeat(64), coverage: 'current',
    protectedThrough: '2026-11-16T00:00:00.000Z', pendingBytes: 0, coveredCount: 5, gapCount: 0,
    jobStatus: null, errorCode: null, lastDrillAt: null, drillStatus: null,
  }] } })
  replies.set('GET /admin/api/peer-backups/scopes', { body: { scopes: [{ id: peerIds.policy, publicId: 'QA protected project' }] } })
  replies.set(`GET /admin/api/peer-backups/${peerIds.policy}/points`, { body: { points: [{ id: peerIds.point,
    protectedThrough: '2026-11-16T00:00:00.000Z', gapCount: 0, coveredCount: 5 }] } })
  replies.set(`GET /admin/api/peer-backups/${kind === 'personal' ? 'personal-recoveries' : 'recoveries'}`, { body: {
    targets: [{ nodeId: fixture.remoteNodeId, volumeId: peerIds.volume }], attempts: [],
  } })
  await page.reload()
  const section = page.locator('section.peerBackupSection')
  await section.getByRole('button', { name: '编辑策略', exact: true }).waitFor()
  return section
}

it('reviews peer-backup policy drafts, quota and credential fingerprints without creating protection', async () => {
  await visit('/deployment', async (page, replies) => {
    const section = await peerPage(page, replies)
    await section.getByRole('button', { name: '添加策略', exact: true }).tap()
    await section.getByRole('combobox', { name: '备份电脑', exact: true }).selectOption(fixture.remoteNodeId)
    await section.getByRole('textbox', { name: '追加凭据指纹（SHA-256）', exact: true }).fill('a'.repeat(64))
    await section.getByRole('textbox', { name: '恢复凭据指纹（SHA-256）', exact: true }).fill('b'.repeat(64))
    for (const kind of ['project', 'personal', 'governance']) {
      await section.getByRole('combobox', { name: '保护类型', exact: true }).selectOption(kind)
      await expect.poll(() => section.getByRole('combobox', { name: '受保护范围', exact: true }).inputValue()).toBe(peerIds.policy)
      await state(page, `peer-policy-create-${kind}`, section)
    }
    await pendingReply(replies, 'PUT /admin/api/peer-backups', peerRefusal,
      () => section.getByRole('button', { name: '保存策略', exact: true }).tap(),
      () => state(page, 'peer-policy-create-pending', section))
    await section.getByRole('alert').waitFor()
    await state(page, 'peer-policy-create-refused', section)
    await section.getByRole('button', { name: '取消', exact: true }).tap()
    await section.getByRole('button', { name: '编辑策略', exact: true }).tap()
    await state(page, 'peer-policy-edit', section)
    await pendingReply(replies, 'PUT /admin/api/peer-backups', peerRefusal,
      () => section.getByRole('button', { name: '保存策略', exact: true }).tap(),
      () => state(page, 'peer-policy-edit-pending', section))
    await section.getByRole('alert').waitFor()
    await state(page, 'peer-policy-edit-refused', section)
  }, true)
}, timeout)

it('reviews peer recovery points, replacement read approvals and isolated drill feedback', async () => {
  await visit('/deployment', async (page, replies) => {
    const section = await peerPage(page, replies)
    const prefix = `/admin/api/peer-backups/${peerIds.policy}`
    replies.set(`GET ${prefix}/recovery-access`, { body: { maxLifetimeMs: 3_600_000, items: [{ id: peerIds.attempt,
      pointId: peerIds.point, recoveryNodeId: peerIds.replacement, policyRevision: 1, expiresAt: '2099-01-01T12:00:00Z', revokedAt: null }] } })
    await section.getByRole('button', { name: '恢复点与演练', exact: true }).tap()
    await section.getByRole('button', { name: '准备替换电脑', exact: true }).waitFor()
    await state(page, 'peer-points-planned-replacement', section)
    await pendingReply(replies, 'POST /admin/api/peer-backups/recoveries', peerRefusal,
      () => section.getByRole('button', { name: '准备替换电脑', exact: true }).tap(),
      () => state(page, 'peer-replacement-prepare-pending', section))
    await section.getByRole('alert').waitFor()
    await state(page, 'peer-replacement-prepare-refused', section)
    await section.getByRole('combobox', { name: '独立演练电脑', exact: true }).selectOption(peerIds.replacement)
    await section.locator('summary').filter({ hasText: '替代电脑的备份读取授权' }).tap()
    const form = section.getByRole('form', { name: '替代电脑的备份读取授权', exact: true })
    await form.getByRole('textbox', { name: '替代电脑读取凭据指纹（SHA-256）', exact: true }).fill('c'.repeat(64))
    await form.getByLabel('读取授权到期时间（本地时间）', { exact: true }).fill('2099-01-01T12:00')
    await state(page, 'peer-read-approval-draft', section)
    await pendingReply(replies, `POST ${prefix}/recovery-access`, peerRefusal,
      () => form.getByRole('button', { name: '授权此电脑读取备份', exact: true }).tap(),
      () => state(page, 'peer-read-approval-pending', section))
    await form.locator('..').getByRole('alert').waitFor()
    await state(page, 'peer-read-approval-refused', section)
    await pendingReply(replies, `POST ${prefix}/recovery-access/${peerIds.attempt}/revoke`, peerRefusal,
      () => section.getByRole('button', { name: '撤销读取授权', exact: true }).tap(),
      () => state(page, 'peer-read-revoke-pending', section))
    await expect.poll(() => section.getByRole('button', { name: '撤销读取授权', exact: true }).isEnabled()).toBe(true)
    await state(page, 'peer-read-revoke-refused', section)
    for (const [name, label, path] of [['drill', '开始隔离演练', 'drill'], ['preflight', '恢复预检', 'preflight']] as const) {
      await pendingReply(replies, `POST ${prefix}/${path}`, peerRefusal,
        () => section.getByRole('button', { name: label, exact: true }).tap(),
        () => state(page, `peer-${name}-pending`, section))
      await expect.poll(() => section.getByRole('button', { name: label, exact: true }).isEnabled()).toBe(true)
      await state(page, `peer-${name}-refused`, section)
    }
  }, true)
}, timeout)

it.each(['project', 'personal'] as const)('reviews %s disaster isolation and activation without changing a recovery operation', async (kind) => {
  await visit('/deployment', async (page, replies) => {
    const section = await peerPage(page, replies, kind)
    const prefix = `/admin/api/peer-backups/${kind === 'personal' ? 'personal-recoveries' : 'recoveries'}`
    const attempt = { id: peerIds.attempt, pointId: peerIds.point, phase: 'prepared', recoveryMode: 'disaster',
      sourceNodeId: fixture.nodeId, targetNodeId: fixture.remoteNodeId, repositoryNodeId: fixture.remoteNodeId,
      sourceGeneration: '1', sourceEpoch: '1', policyRevision: 1, currentPolicyRevision: 1, policyEnabled: true,
      reapprovalRequired: false, cleanupPending: false, affectedMemberCount: 2 }
    replies.set(`GET ${prefix}`, { body: { targets: [{ nodeId: fixture.remoteNodeId, volumeId: peerIds.volume }], attempts: [attempt] } })
    await section.getByRole('button', { name: '恢复点与演练', exact: true }).tap()
    await section.getByRole('button', { name: '记录原电脑隔离', exact: true }).waitFor()
    await state(page, `peer-${kind}-isolation-required`, section)
    await section.getByRole('button', { name: '记录原电脑隔离', exact: true }).tap()
    await state(page, `peer-${kind}-isolation-draft`, section)
    await section.getByRole('textbox', { name: '隔离证据编号或记录位置', exact: true }).fill('QA change record 2026-11-17')
    await section.getByRole('checkbox', { name: '我已核实原电脑无法继续执行任务或对外写入', exact: true }).locator('..').tap()
    await section.getByRole('checkbox', { name: '我接受恢复点后的数据缺口，并将核对任务执行结果', exact: true }).locator('..').tap()
    await pendingReply(replies, `POST ${prefix}/${peerIds.attempt}/confirm-isolation`, peerRefusal,
      () => section.getByRole('button', { name: '确认隔离并准备恢复', exact: true }).tap(),
      () => state(page, `peer-${kind}-isolation-pending`, section))
    await section.getByRole('alert').waitFor()
    await state(page, `peer-${kind}-isolation-refused`, section)
    await section.getByRole('button', { name: '返回', exact: true }).tap()
    for (const [name, phase, action] of kind === 'project'
      ? [['retirement', 'target-ready', 'approve-retirement'], ['activate', 'old-fenced', 'activate']]
      : [['activate', 'externally-fenced', 'activate']]) {
      replies.set(`GET ${prefix}`, { body: { targets: [], attempts: [{ ...attempt, phase }] } })
      await section.getByRole('button', { name: '刷新接管状态', exact: true }).tap()
      await section.getByRole('button', { name: name === 'retirement' ? '审核原机退出' : '审核切换', exact: true }).tap()
      await state(page, `peer-${kind}-${name}-confirm`, section)
      await pendingReply(replies, `POST ${prefix}/${peerIds.attempt}/${action}`, peerRefusal,
        () => section.getByRole('button', { name: '确认', exact: true }).tap(),
        () => state(page, `peer-${kind}-${name}-pending`, section))
      await section.getByRole('alert').waitFor()
      await state(page, `peer-${kind}-${name}-refused`, section)
      await section.getByRole('button', { name: '返回', exact: true }).tap()
    }
    replies.set(`GET ${prefix}`, { body: { targets: [], attempts: [{ ...attempt, phase: 'old-fenced',
      currentPolicyRevision: 2, reapprovalRequired: true }] } })
    await section.getByRole('button', { name: '刷新接管状态', exact: true }).tap()
    await section.getByRole('button', { name: '审核继续接管', exact: true }).tap()
    await state(page, `peer-${kind}-reapproval-confirm`, section)
    await pendingReply(replies, `POST ${prefix}/${peerIds.attempt}/reapprove`, peerRefusal,
      () => section.getByRole('button', { name: '确认继续', exact: true }).tap(),
      () => state(page, `peer-${kind}-reapproval-pending`, section))
    await section.getByRole('alert').waitFor()
    await state(page, `peer-${kind}-reapproval-refused`, section)
  }, true)
}, timeout)

it.each(['project', 'personal'] as const)('reviews local %s execution preparation, disclosures and independent approvals', async (kind) => {
  await visit('/deployment', async (page, replies) => {
    const prefix = `/admin/api/peer-backups/${kind === 'personal' ? 'personal-recoveries' : 'recoveries'}/${peerIds.attempt}/execution`
    const initial = { recoveryMode: 'disaster', phase: 'published', runtimeId, pointId: peerIds.point,
      targetNodeId: fixture.nodeId, targetEpoch: '1', reviewRevision: null, status: 'unprepared',
      preparationStatus: 'idle', errorCode: null, oldSessionCount: null, tasksSuspended: true, sessionsReadOnly: true,
      suspendedEnvironmentKeys: ['QA_DATABASE_URL', 'QA_REMOTE_CONNECTION'], items: [], blockers: [] }
    replies.set('GET /admin/api/peer-backups/recoveries/local-execution', { body: { items: [{ id: peerIds.attempt,
      scopeKind: kind, runtimeId, pointId: peerIds.point, projectId: fixture.projectId, userId: fixture.adminId }] } })
    replies.set(`GET ${prefix}`, { body: initial })
    await page.reload()
    const review = page.getByRole('region', { name: '恢复后的运行许可', exact: true })
    await review.getByRole('button', { name: '检查恢复后的运行配置', exact: true }).waitFor()
    await state(page, `peer-local-${kind}-execution-unprepared`, review)
    replies.set(`GET ${prefix}`, { body: { ...initial, preparationStatus: 'queued' } })
    await pendingReply(replies, `POST ${prefix}/prepare`, { body: { queued: true } },
      () => review.getByRole('button', { name: '检查恢复后的运行配置', exact: true }).tap(),
      () => state(page, `peer-local-${kind}-execution-prepare-pending`, review))
    await review.getByText('正在检查恢复数据与插件配置。可稍后刷新查看结果。', { exact: true }).waitFor()
    await state(page, `peer-local-${kind}-execution-queued`, review)
    replies.set(`GET ${prefix}`, { body: { ...initial, preparationStatus: 'failed',
      errorCode: 'peer-backup/execution-policy-missing', blockers: ['peer-backup/execution-policy-missing'] } })
    await review.getByRole('button', { name: '刷新运行审核状态', exact: true }).tap()
    await review.getByText('节点的恢复许可文件缺失或校验不一致。请从该电脑的备份恢复原文件后重新检查；系统不会自动解除旧任务限制。', { exact: true }).waitFor()
    await state(page, `peer-local-${kind}-execution-failed`, review)
    const item = { id: 'qa-plugin', kind: 'plugin', name: 'QA restored integration with long display name',
      itemDigest: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), status: 'eligible' }
    const ready = { ...initial, reviewRevision: 'review-1', status: 'review-required', preparationStatus: 'ready', oldSessionCount: 12,
      items: [item, { ...item, id: 'qa-disabled', name: 'QA suspended hook', status: 'suspended', reason: 'hook-source-unavailable' },
        { ...item, id: 'qa-approved', name: 'QA approved integration', status: 'approved' }] }
    replies.set(`GET ${prefix}`, { body: ready })
    await review.getByRole('button', { name: '刷新运行审核状态', exact: true }).tap()
    await review.getByRole('button', { name: '审核新对话许可', exact: true }).waitFor()
    await state(page, `peer-local-${kind}-execution-ready`, review)
    for (const summary of await review.locator('summary').all()) {
      if (!await summary.isVisible()) continue
      await summary.tap()
    }
    for (const summary of await review.locator('summary').filter({ hasText: '查看审核版本' }).all()) {
      if (!await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.tap()
    }
    await state(page, `peer-local-${kind}-execution-disclosures`, review)
    for (const operation of ['item', 'enable']) {
      await review.getByRole('button', { name: operation === 'item' ? `审核 ${item.name}` : '审核新对话许可', exact: true }).tap()
      if (operation === 'item') await review.getByRole('textbox', { name: '审核证据编号或记录位置', exact: true }).fill('QA review record')
      await review.getByRole('checkbox', { name: operation === 'item' ? '我已核对该项目的配置和外部执行结果' : '我确认只开放新对话，旧任务继续暂停', exact: true }).locator('..').tap()
      await state(page, `peer-local-${kind}-execution-${operation}-draft`, review)
      await pendingReply(replies, `POST ${prefix}/${operation === 'item' ? `items/${item.id}/approve` : 'enable'}`, peerRefusal,
        () => review.getByRole('button', { name: operation === 'item' ? '批准此项目' : '启用新对话', exact: true }).tap(),
        () => state(page, `peer-local-${kind}-execution-${operation}-pending`, review))
      await review.getByRole('alert').waitFor()
      await state(page, `peer-local-${kind}-execution-${operation}-refused`, review)
      await review.getByRole('button', { name: '返回', exact: true }).tap()
    }
    replies.set(`GET ${prefix}`, { body: { ...ready, status: 'new-conversations-enabled' } })
    await review.getByRole('button', { name: '刷新运行审核状态', exact: true }).tap()
    await review.getByText('已允许新对话；历史会话仍为只读。', { exact: true }).waitFor()
    await state(page, `peer-local-${kind}-execution-enabled`, review)
  })
}, timeout)

it('reviews existing project directories through loading, hidden entries, refused reads and selection', async () => {
  await visit('/projects', async (page, replies) => {
    const directory = { path: '/qa', scope: 'configured-roots', crumbs: [{ name: 'QA roots', path: null }, { name: 'qa', path: '/qa' }],
      entries: [{ name: 'LongExistingProjectDirectoryWithoutBreaks0123456789', path: '/qa/project', hidden: false },
        { name: '.retained-hidden', path: '/qa/.retained-hidden', hidden: true }], selectable: true, truncated: true }
    await page.getByRole('button', { name: '新建项目', exact: true }).tap()
    const dialog = page.getByRole('dialog')
    await pendingReply(replies, 'GET /admin/api/project-directories', { body: directory },
      () => dialog.getByRole('button', { name: '现有目录', exact: true }).tap(),
      () => state(page, 'project-directory-loading', dialog))
    await dialog.getByRole('button', { name: /^打开目录 LongExisting/ }).waitFor()
    await state(page, 'project-directory-ready', dialog)
    await dialog.getByRole('checkbox', { name: '显示隐藏目录 (1)', exact: true }).locator('..').tap()
    await state(page, 'project-directory-hidden-entries', dialog)
    replies.set('GET /admin/api/project-directories', { status: 403, body: { error: 'project-directory-path-inaccessible' } })
    await dialog.getByRole('button', { name: /^打开目录 LongExisting/ }).tap()
    await dialog.getByRole('alert').waitFor()
    await state(page, 'project-directory-read-refused', dialog)
    replies.set('GET /admin/api/project-directories', { body: { ...directory, path: '/qa/project', entries: [], truncated: false,
      crumbs: [...directory.crumbs, { name: 'LongExistingProjectDirectoryWithoutBreaks0123456789', path: '/qa/project' }] } })
    await dialog.getByRole('button', { name: '重试', exact: true }).tap()
    await dialog.getByText('没有可浏览的子目录', { exact: true }).waitFor()
    await state(page, 'project-directory-empty', dialog)
    await dialog.getByRole('button', { name: '使用当前目录', exact: true }).tap()
    await state(page, 'project-directory-selected', dialog)
    await pendingReply(replies, 'POST /admin/api/projects', refusal,
      () => dialog.getByRole('button', { name: '创建项目', exact: true }).tap(),
      () => state(page, 'project-existing-directory-create-pending', dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, 'project-existing-directory-create-refused', dialog)
  })
}, timeout)

it.each(['project', 'user'] as const)('keeps the %s membership removal failure inside its own confirmation', async (kind) => {
  await visit(kind === 'project' ? `/projects/${fixture.projectId}` : `/users/${fixture.adminId}`, async (page, replies) => {
    if (kind === 'project') {
      const project = await (await page.request.get(`${fixture.base}/admin/api/projects/${fixture.projectId}`)).json() as ProjectDetail
      const user = await (await page.request.get(`${fixture.base}/admin/api/users/${fixture.adminId}`)).json() as AdminUser
      replies.set('GET /admin/api/users', { body: [{ ...user, id: 2, role: 'user', username: 'qa-member', displayName: 'QA project member' }] })
      replies.set(`GET /admin/api/projects/${fixture.projectId}`, { body: { ...project, memberCount: 1,
        members: [{ userId: 2, username: 'qa-member', mode: 'rw' }] } })
    } else {
      replies.set(`GET /admin/api/users/${fixture.adminId}/memberships`, { body: { memberships: [{ projectId: fixture.projectId,
        name: 'QA project membership with retained long name', path: '/qa/retained-project-directory', mode: 'rw' }] } })
    }
    await page.reload()
    if (kind === 'project') await page.getByRole('button', { name: '无权限', exact: true }).filter({ visible: true }).tap()
    else await page.getByRole('button', { name: /^移出 QA project membership/ }).filter({ visible: true }).tap()
    const dialog = page.getByRole('dialog', { name: kind === 'project' ? '移除项目成员' : '移出项目', exact: true })
    await state(page, `${kind}-membership-remove-confirm`, dialog)
    await pendingReply(replies, `DELETE /admin/api/projects/${fixture.projectId}/members/${kind === 'project' ? 2 : fixture.adminId}`, refusal,
      () => dialog.getByRole('button', { name: kind === 'project' ? '确认移除' : '确认移出', exact: true }).tap(),
      () => state(page, `${kind}-membership-remove-pending`, dialog))
    await dialog.getByRole('alert').waitFor()
    await state(page, `${kind}-membership-remove-refused`, dialog)
  })
}, timeout)

it.each(['project', 'user'] as const)('reviews %s quota inheritance, unlimited and custom values through validation and refusal', async (kind) => {
  await visit(kind === 'project' ? `/projects/${fixture.projectId}` : `/users/${fixture.adminId}`, async (page, replies) => {
    if (kind === 'project') await page.getByRole('button', { name: '配置额度', exact: true }).tap()
    const surface = kind === 'project' ? page.getByRole('dialog', { name: '配置项目额度', exact: true })
      : page.locator('section').filter({ has: page.getByRole('heading', { name: '配额', exact: true }) })
    const token = surface.getByRole('group', { name: 'Token 额度', exact: true })
    const cost = surface.getByRole('group', { name: '公司成本额度', exact: true })
    if (kind === 'project') await surface.getByRole('radio', { name: /^继承普通成员额度/ }).check()
    else {
      await token.getByLabel('额度模式', { exact: true }).selectOption('inherit')
      await cost.getByLabel('额度模式', { exact: true }).selectOption('inherit')
    }
    await state(page, `${kind}-quota-inherit`, surface)
    if (kind === 'project') await surface.getByRole('radio', { name: /^项目独立额度/ }).check()
    await token.getByLabel('额度模式', { exact: true }).selectOption('unlimited')
    await cost.getByLabel('额度模式', { exact: true }).selectOption('unlimited')
    await state(page, `${kind}-quota-unlimited`, surface)
    await token.getByLabel('额度模式', { exact: true }).selectOption('custom')
    await cost.getByLabel('额度模式', { exact: true }).selectOption('custom')
    await token.getByLabel('每月 Token', { exact: true }).fill('invalid-quota')
    await cost.getByLabel('每月人民币元', { exact: true }).fill('99.25')
    const save = surface.getByRole('button', { name: kind === 'project' ? '保存额度' : '保存配额', exact: true })
    await save.tap()
    await surface.getByRole('alert').waitFor()
    await state(page, `${kind}-quota-invalid-token`, surface)
    await token.getByLabel('每月 Token', { exact: true }).fill('12345')
    await cost.getByLabel('每月人民币元', { exact: true }).fill('invalid-cost')
    await save.tap()
    await surface.getByText('成本额度必须是有效的非负数', { exact: true }).waitFor()
    await state(page, `${kind}-quota-invalid-cost`, surface)
    await cost.getByLabel('每月人民币元', { exact: true }).fill('99.25')
    await state(page, `${kind}-quota-custom`, surface)
    await pendingReply(replies, 'PUT /admin/api/quotas', refusal, () => save.tap(),
      () => state(page, `${kind}-quota-pending`, surface))
    await surface.getByText('QA write refused. The reviewed record remains unchanged.', { exact: true }).waitFor()
    await state(page, `${kind}-quota-refused`, surface)
  })
}, timeout)

it('reviews organization Provider creation, discovery, editing and deletion through isolated refusals', async () => {
  await visit('/models', async (page, replies) => {
    const current = await (await page.request.get(`${fixture.base}/admin/api/model-settings`)).json() as OrganizationModelSettingsView
    const setProviders = (providers: Record<string, unknown>) => {
      replies.set('GET /admin/api/model-settings', { body: { ...current, writable: true,
        namespaces: current.namespaces.map(namespace => ({
          ...namespace, value: { providers }, base: { providers: {} }, user: { providers },
        })) } })
    }
    setProviders({})
    await page.reload()
    await page.getByRole('button', { name: '添加组织 Provider', exact: true }).tap()
    const editor = page.locator('.organizationModelsEditor')
    await editor.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('org-responsive-qa')
    await editor.getByRole('textbox', { name: '显示名称', exact: true }).fill('QA organization provider with a long readable name')
    await editor.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://model-provider.example.invalid/v1')
    await editor.getByRole('combobox', { name: 'API 协议', exact: true }).selectOption('openai-completions')
    await state(page, 'provider-create-full', editor)
    await editor.getByRole('button', { name: '添加模型', exact: true }).tap()
    await editor.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('qa-model')
    await editor.getByRole('button', { name: '容量 1', exact: true }).tap()
    await editor.getByRole('textbox', { name: '上下文窗口（token） 1', exact: true }).fill('256K')
    await editor.getByRole('textbox', { name: '最大输出（token） 1', exact: true }).fill('32K')
    await state(page, 'provider-model-capacities', editor)
    const discover = editor.getByRole('button', { name: '获取可用模型', exact: true })
    await pendingReply(replies, 'POST /admin/api/model-settings/discover', { body: { models: [] } },
      () => discover.tap(), () => state(page, 'provider-discovery-pending', editor))
    await editor.getByText('该提供方没有列出任何模型，请手动添加。', { exact: true }).waitFor()
    await state(page, 'provider-discovery-empty', editor)
    replies.set('POST /admin/api/model-settings/discover', refusal)
    await discover.tap()
    await editor.getByText('QA write refused. The reviewed record remains unchanged.', { exact: true }).waitFor()
    await state(page, 'provider-discovery-refused', editor)
    replies.set('POST /admin/api/model-settings/discover', { body: { models: [
      { id: 'qa-model', name: 'Current catalog model', contextWindow: 256000 },
      { id: 'qa-discovered-long-model-identifier', name: 'A discovered model with a long visible label', contextWindow: 128000, maxTokens: 16000 },
    ] } })
    await discover.tap()
    const picker = page.getByRole('dialog', { name: '选择要添加的模型', exact: true })
    await state(page, 'provider-discovery-candidates', picker)
    await picker.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('no-match-qa')
    await state(page, 'provider-discovery-no-match', picker)
    await picker.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('')
    await picker.getByRole('button', { name: '添加所选', exact: true }).tap()
    await state(page, 'provider-discovery-adopted', editor)
    await pendingReply(replies, 'PUT /admin/api/model-settings', refusal,
      () => editor.getByRole('button', { name: '创建组织 Provider', exact: true }).tap(),
      () => state(page, 'provider-create-pending', editor))
    await editor.getByText('QA write refused. The reviewed record remains unchanged.', { exact: true }).waitFor()
    await state(page, 'provider-create-refused', editor)
    await editor.getByRole('button', { name: '取消', exact: true }).tap()
    setProviders({ 'org-responsive-qa': { displayName: 'QA provider', baseURL: 'https://model-provider.example.invalid/v1',
      api: 'openai-completions', models: [{ id: 'qa-model', name: 'QA model', contextWindow: 256000, maxTokens: 32000 }] } })
    await page.reload()
    await page.getByRole('button', { name: '编辑 QA provider (org-responsive-qa)', exact: true }).tap()
    await state(page, 'provider-edit-loaded', editor)
    await editor.locator('summary').filter({ hasText: '自定义设置' }).tap()
    await editor.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://changed-provider.example.invalid/v1')
    await pendingReply(replies, 'PUT /admin/api/model-settings', refusal,
      () => editor.getByRole('button', { name: '保存', exact: true }).tap(),
      () => state(page, 'provider-edit-pending', editor))
    await editor.getByText('QA write refused. The reviewed record remains unchanged.', { exact: true }).waitFor()
    await state(page, 'provider-edit-refused', editor)
    await editor.getByRole('button', { name: '取消', exact: true }).tap()
    await page.getByRole('button', { name: '删除 QA provider (org-responsive-qa)', exact: true }).tap()
    const removal = page.getByRole('dialog', { name: '删除 QA provider (org-responsive-qa)？', exact: true })
    await state(page, 'provider-delete-confirm', removal)
    await pendingReply(replies, 'PUT /admin/api/model-settings', refusal,
      () => removal.getByRole('button', { name: '删除 QA provider (org-responsive-qa)', exact: true }).tap(),
      () => state(page, 'provider-delete-pending', removal))
    await removal.getByText('QA write refused. The reviewed record remains unchanged.', { exact: true }).waitFor()
    await state(page, 'provider-delete-refused', removal)
  })
}, matrix ? 1_200_000 : 60_000)

it.each(['organization', 'user'] as const)('reviews %s Runtime allocation limits through validation, conflict and refreshed values', async (kind) => {
  await visit(kind === 'organization' ? '/deployment' : `/users/${fixture.adminId}`, async (page, replies) => {
    const path = `/admin/api/${kind === 'user' ? `users/${fixture.adminId}/` : ''}runtime-allocation-policy`
    const inherited = { revision: '1', maxTotal: 8, maxPerNode: 2, source: 'organization' }
    replies.set(`GET ${path}`, { body: inherited })
    await page.reload()
    if (kind === 'user') await page.locator('summary').filter({ hasText: 'Runtime 配额' }).tap()
    const form = page.locator('.runtimePolicy')
    const total = form.getByLabel('总配额', { exact: true })
    const perNode = form.getByLabel(/^(每台电脑|当前环境)配额$/)
    await expect.poll(() => total.inputValue()).toBe('8')
    await state(page, `runtime-policy-${kind}-inherited`, form)
    await total.fill('1')
    await perNode.fill('2')
    expect(await form.getByRole('button', { name: '保存 Runtime 配额', exact: true }).isDisabled()).toBe(true)
    await state(page, `runtime-policy-${kind}-invalid`, form)
    await total.fill('12')
    await perNode.fill('4')
    await pendingReply(replies, `PUT ${path}`, refusal,
      () => form.getByRole('button', { name: '保存 Runtime 配额', exact: true }).tap(),
      () => state(page, `runtime-policy-${kind}-pending`, form))
    await form.getByRole('alert').waitFor()
    expect(await total.isDisabled()).toBe(true)
    await state(page, `runtime-policy-${kind}-refresh-required`, form)
    replies.set(`GET ${path}`, { body: { ...inherited, revision: '2', maxTotal: 10, maxPerNode: 3,
      source: kind === 'user' ? 'user' : 'organization' } })
    await form.getByRole('button', { name: '刷新配额', exact: true }).tap()
    await expect.poll(() => total.inputValue()).toBe('10')
    await state(page, `runtime-policy-${kind}-refreshed`, form)
    if (kind === 'user') {
      await pendingReply(replies, `PUT ${path}`, refusal,
        () => form.getByRole('button', { name: '沿用组织配置', exact: true }).tap(),
        () => state(page, 'runtime-policy-user-restore-pending', form))
      await form.getByRole('alert').waitFor()
      await state(page, 'runtime-policy-user-restore-refused', form)
      await form.getByRole('button', { name: '刷新配额', exact: true }).tap()
      await expect.poll(() => total.isEnabled()).toBe(true)
      replies.set(`PUT ${path}`, { body: { ...inherited, revision: '3' } })
      replies.set(`GET ${path}`, { body: { ...inherited, revision: '3' } })
      await form.getByRole('button', { name: '沿用组织配置', exact: true }).tap()
      await expect.poll(() => total.inputValue()).toBe('8')
      await state(page, 'runtime-policy-user-restored', form)
    }
  }, true)
}, timeout)
