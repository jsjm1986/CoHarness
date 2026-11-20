/** Recovery-only routing, exact revisions and browser-owned review drafts. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import type { GovernanceRebuildStatus } from '../../../src/governance-rebuild-review.ts'

const operation = '11111111-1111-4111-8111-111111111111'
const user = '22222222-2222-4222-8222-222222222222'
const node = '33333333-3333-4333-8333-333333333333'
const review = '44444444-4444-4444-8444-444444444444'
function state(): GovernanceRebuildStatus { return { operationId: operation, state: 'review', revision: '1', sourceNodeId: node,
  targetNodeId: node, unrestoredDomains: ['authorization:computer-project-model-and-plugin-grants'],
  accounts: [{ userId: user, publicId: 1, username: 'Member', role: 'admin', sourceStatus: 'active', deleted: false, bootstrap: false, decision: null }],
  nodes: [{ nodeId: node, name: 'Isolated source', sourceStatus: 'active', decision: null, quarantined: true }], runtimes: [], unreconfiguredItems: [],
  continuation: { accounts: null, nodes: null, runtimes: null, configuration: null } } }
const base = '/admin/api/governance-recovery'
function setup(handler: (path: string, init?: RequestInit) => Promise<Response> | Response, pathname = '/admin/governance-recovery') {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  window.history.replaceState(null, '', pathname)
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input).startsWith(base)).toBe(true)
    return handler(String(input), init)
  })
  vi.stubGlobal('fetch', fetch)
  render(<App />)
  return fetch
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/admin/') })

it('loads only the restricted API and retains a password through pagination, refresh and a revision conflict', async () => {
  let current = state(), posts = 0
  current.continuation.accounts = user
  const fetch = setup((path, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ error: 'peer-backup/governance-review-changed' }, { status: 409 }) }
    return Response.json(path.includes('?accounts=') ? { ...current, accounts: [{ ...current.accounts[0]!, userId: node, username: 'Another member' }],
      continuation: { ...current.continuation, accounts: null } } : current)
  })
  fireEvent.click(await screen.findByRole('button', { name: '审核账号 Member' }))
  fireEvent.change(screen.getByRole('combobox', { name: '账号登录' }), { target: { value: 'restore' } })
  const password = screen.getByLabelText(/新密码/u)
  fireEvent.change(password, { target: { value: 'retained-test-password' } })
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  await screen.findByText('Another member')
  expect((password as HTMLInputElement).value).toBe('retained-test-password')
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核对当前对象和上述影响' }))
  fireEvent.click(screen.getByRole('button', { name: '确认审核' }))
  await waitFor(() => expect(posts).toBe(1))
  expect((password as HTMLInputElement).value).toBe('retained-test-password')
  expect((screen.getByRole('button', { name: '确认审核' }) as HTMLButtonElement).disabled).toBe(true)
  current = { ...current, revision: '2' }
  fireEvent.click(screen.getByRole('button', { name: '刷新审核状态' }))
  await screen.findByText('审核版本 2')
  expect((password as HTMLInputElement).value).toBe('retained-test-password')
  fireEvent.click(screen.getByRole('button', { name: '使用已核对的新版本' }))
  expect((screen.getByRole('checkbox', { name: '我已核对当前对象和上述影响' }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('button', { name: '确认审核' }) as HTMLButtonElement).disabled).toBe(true)
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')[0]?.[1]?.body).toContain('"revision":"1"')
  expect(screen.queryByRole('button', { name: '审核电脑 Isolated source' })).toBeNull()
  expect(localStorage.setItem).not.toHaveBeenCalled()
})

it('requires each unrestored domain and acknowledgement before opening management', async () => {
  let submitted: unknown
  const current = state()
  setup((_path, init) => {
    if (init?.method === 'POST') { submitted = JSON.parse(String(init.body)); return Response.json({ revision: '2' }) }
    return Response.json(current)
  })
  fireEvent.click(await screen.findByRole('button', { name: '开放管理入口' }))
  expect((screen.getByRole('button', { name: '确认审核' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '电脑、项目、模型与插件授权' }))
  expect((screen.getByRole('button', { name: '确认审核' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '我知道这些内容尚未恢复，开放入口后仍需分别处理' }))
  fireEvent.click(screen.getByRole('button', { name: '确认审核' }))
  await waitFor(() => expect(submitted).toEqual({ confirm: operation, revision: '1', acknowledgeUnrestoredDomains: current.unrestoredDomains }))
})

it('routes execution review by runtime review identity and does not send local paths to another computer', async () => {
  const current = state()
  current.runtimes = [{ id: review, runtimeId: user, nodeId: node, ownerKind: 'user', ownerPublicId: 1,
    observedState: 'stopped', generation: '1', sourceGeneration: '1', executionReviewRequired: true, dataBinding: 'verified', bindingErrorCode: null }]
  const fetch = setup(path => Response.json(path.endsWith('/execution') ? {
    recoveryMode: 'disaster', phase: 'published', runtimeId: user, pointId: operation, targetNodeId: node, targetEpoch: '1', reviewRevision: null,
    status: 'unprepared', preparationStatus: 'idle', errorCode: null, oldSessionCount: null, tasksSuspended: true, sessionsReadOnly: true, items: [], blockers: [],
  } : current))
  fireEvent.click(await screen.findByRole('button', { name: '查看此 Runtime' }))
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === base + '/' + operation + '/runtimes/' + review + '/execution')).toBe(true))
  expect(fetch.mock.calls.every(([url]) => !String(url).includes('peer-backups'))).toBe(true)
})

it('does not revive an aborted status read after the page unmounts', async () => {
  let finish!: (response: Response) => void, signal: AbortSignal | undefined
  setup((_path, init) => { signal = init?.signal ?? undefined; return new Promise(resolve => { finish = resolve }) })
  await waitFor(() => expect(signal).toBeDefined())
  cleanup()
  expect(signal?.aborted).toBe(true)
  await act(async () => { finish(Response.json(state())) })
  expect(screen.queryByText('Member')).toBeNull()
})

it('keeps a refused draft inaccessible until a fresh authorized read without erasing its input', async () => {
  let refuse = false
  setup(() => refuse ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(state()))
  fireEvent.click(await screen.findByRole('button', { name: '审核账号 Member' }))
  fireEvent.change(screen.getByRole('combobox', { name: '账号登录' }), { target: { value: 'restore' } })
  fireEvent.change(screen.getByLabelText(/新密码/u), { target: { value: 'private-retained-draft' } })
  refuse = true
  fireEvent.click(screen.getByRole('button', { name: '刷新审核状态' }))
  await screen.findByText('当前账号不能执行恢复审核，请使用本次恢复管理员登录')
  expect(screen.queryByRole('combobox', { name: '账号登录' })).toBeNull()
  refuse = false
  fireEvent.click(screen.getByRole('button', { name: '刷新审核状态' }))
  await screen.findByRole('combobox', { name: '账号登录' })
  expect((screen.getByLabelText(/新密码/u) as HTMLInputElement).value).toBe('private-retained-draft')
})

it('uses only the local projection and exact local Runtime binding API at a direct computer entry', async () => {
  let submitted: unknown
  const row = { id: review, runtimeId: user, nodeId: node, ownerKind: 'user', ownerPublicId: 1, observedState: 'stopped', generation: '1',
    sourceGeneration: '1', executionReviewRequired: true, dataBinding: 'unbound', bindingErrorCode: null }
  const local = { localOnly: true, operationId: operation, state: 'released', revision: '4', sourceNodeId: user, targetNodeId: user,
    localNodeId: node, runtimes: [row], continuation: { runtimes: null } }
  setup((path, init) => {
    if (init?.method === 'POST') { expect(path).toBe(base + '/' + operation + '/runtimes/' + review + '/bind-data'); submitted = JSON.parse(String(init.body)); return Response.json({ status: 'accepted' }, { status: 202 }) }
    expect(path).toBe(base + '/local')
    return Response.json(local)
  }, '/admin/governance-recovery/local')
  fireEvent.click(await screen.findByRole('button', { name: '查看此 Runtime' }))
  expect(screen.queryByRole('heading', { name: '账号登录' })).toBeNull()
  expect(screen.queryByRole('heading', { name: '电脑接入' })).toBeNull()
  expect(screen.queryByRole('button', { name: '开放管理入口' })).toBeNull()
  fireEvent.click(screen.getByText('指定本机数据位置'))
  fireEvent.change(screen.getByLabelText('工作目录绝对路径'), { target: { value: '/local/retained-home' } })
  fireEvent.change(screen.getByLabelText('Runtime 数据目录（可选）'), { target: { value: '/local/retained-runtime' } })
  fireEvent.click(screen.getByRole('button', { name: '核验所选目录' }))
  await waitFor(() => expect(submitted).toEqual({ confirm: review, selection: { homePath: '/local/retained-home', runtimeHome: '/local/retained-runtime' } }))
  await screen.findByText('已提交数据核验；刷新查看结果')
})
