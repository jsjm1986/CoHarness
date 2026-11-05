import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeploymentNode } from '../api.ts'
import { PeerBackupSection } from './PeerBackupSection.tsx'

const source = '11111111-1111-4111-8111-111111111111',
  target = '22222222-2222-4222-8222-222222222222'
function node(nodeId: string, name: string): DeploymentNode {
  return {
    nodeId,
    name,
    status: 'active',
    lastHeartbeatAt: null,
    heartbeatAgeMs: null,
    maintenanceAppliedEpoch: '1',
    inflightWrites: 0,
    activeRuntimes: 0,
    quiesced: false,
  }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps the chosen receiving computer and unsaved quota while refreshing, and submits only explicit scope credentials fingerprints', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, options })
      return Response.json(
        url.includes('/scopes?')
          ? { scopes: [{ id: source, publicId: 19 }] }
          : { policies: [], localWorkerConfigured: true },
      )
    }),
  )
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Ubuntu')]} />)
  fireEvent.click(screen.getByRole('button', { name: '添加策略' }))
  await screen.findByRole('option', { name: /19/ })
  const receiver = screen.getByLabelText('备份电脑')
  expect(within(receiver).queryByRole('option', { name: 'Mac' })).toBeNull()
  fireEvent.change(receiver, { target: { value: target } })
  fireEvent.change(screen.getByLabelText('仓库配额（MiB）'), { target: { value: '128' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect((screen.getByLabelText('备份电脑') as HTMLSelectElement).value).toBe(target))
  expect((screen.getByLabelText('仓库配额（MiB）') as HTMLInputElement).value).toBe('128')
  fireEvent.change(screen.getByLabelText(/追加凭据指纹/), { target: { value: 'a'.repeat(64) } })
  fireEvent.change(screen.getByLabelText(/恢复凭据指纹/), { target: { value: 'b'.repeat(64) } })
  fireEvent.click(screen.getByRole('button', { name: '保存策略' }))
  await waitFor(() => {
    const put = calls.find((call) => call.options?.method === 'PUT')
    expect(put).toBeDefined()
    expect(JSON.parse(String(put!.options!.body))).toMatchObject({
      sourceNodeId: source,
      targetNodeId: target,
      scopeId: source,
      quotaBytes: 128 << 20,
      appendFingerprint: 'a'.repeat(64),
      recoveryFingerprint: 'b'.repeat(64),
    })
  })
})

it('asks for a separate retirement confirmation for the selected project operation', async () => {
  const policy = '33333333-3333-4333-8333-333333333333',
    point = '44444444-4444-4444-8444-444444444444',
    attempt = '55555555-5555-4555-8555-555555555555'
  const mutations: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        mutations.push({ url, body: JSON.parse(String(options.body)) })
        return Response.json({ id: attempt })
      }
      if (url.includes('/recoveries?'))
        return Response.json({
          targets: [{ nodeId: target, volumeId: source }],
          attempts: [{ id: attempt, pointId: point, phase: 'target-ready' }],
        })
      if (url.endsWith('/points'))
        return Response.json({
          points: [{ id: point, gapCount: 0, coveredCount: 3, protectedThrough: new Date().toISOString() }],
        })
      return Response.json({
        localWorkerConfigured: true,
        recoveryConfigured: true,
        policies: [
          {
            policyId: policy,
            sourceNodeId: source,
            targetNodeId: target,
            scopeKind: 'project',
            scopeId: source,
            tier: 'important',
            enabled: true,
            quotaBytes: 16 << 20,
            coverage: 'current',
            protectedThrough: null,
            coveredCount: 3,
            gapCount: 0,
          },
        ],
      })
    }),
  )
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Ubuntu')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '审核原机退出' }))
  expect(mutations).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  await waitFor(() =>
    expect(mutations).toEqual([
      { url: '/admin/api/peer-backups/recoveries/' + attempt + '/approve-retirement', body: { confirm: attempt } },
    ]),
  )
})

const policyId = '33333333-3333-4333-8333-333333333333',
  pointId = '44444444-4444-4444-8444-444444444444',
  attemptId = '55555555-5555-4555-8555-555555555555',
  volumeA = '66666666-6666-4666-8666-666666666666',
  volumeB = '77777777-7777-4777-8777-777777777777'
const protectedPolicy = {
  policyId,
  sourceNodeId: source,
  targetNodeId: target,
  scopeKind: 'project',
  scopeId: source,
  tier: 'important',
  revision: 3,
  enabled: true,
  quotaBytes: 16 << 20,
  coverage: 'current',
  protectedThrough: null,
  coveredCount: 3,
  gapCount: 0,
}
function protectionRead(url: string) {
  return Response.json(url.endsWith('/points') ? {
    points: [{ id: pointId, gapCount: 0, coveredCount: 3, protectedThrough: new Date().toISOString() }],
  } : { localWorkerConfigured: true, recoveryConfigured: true, policies: [protectedPolicy] })
}

it('requires an explicit verified volume when the receiver has multiple volumes', async () => {
  const mutations: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      mutations.push(JSON.parse(String(options.body)))
      return Response.json({ operationId: attemptId })
    }
    if (url.includes('/recoveries?')) return Response.json({
      targets: [volumeA, volumeB].map((volumeId) => ({ nodeId: target, volumeId })), attempts: [],
    })
    return protectionRead(url)
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  const volume = await screen.findByLabelText('目标数据卷')
  expect(screen.getByRole('button', { name: '准备替换电脑' }).hasAttribute('disabled')).toBe(true)
  expect(mutations).toHaveLength(0)
  fireEvent.change(volume, { target: { value: volumeB } })
  fireEvent.click(screen.getByRole('button', { name: '准备替换电脑' }))
  await waitFor(() => expect(mutations).toEqual([expect.objectContaining({
    policyId, pointId, targetNode: target, targetVolume: volumeB,
  })]))
})

it('keeps a fenced writer sealed and separately confirms the exact policy revision before continuation', async () => {
  const mutations: Array<{ url: string; body: unknown }> = []
  let reapprovalRequired = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      mutations.push({ url, body: JSON.parse(String(options.body)) })
      reapprovalRequired = false
      return Response.json({ id: attemptId })
    }
    if (url.includes('/recoveries?')) return Response.json({ targets: [{ nodeId: target, volumeId: volumeA }],
      attempts: [{ id: attemptId, phase: 'old-fenced', pointId, policyRevision: 2, currentPolicyRevision: 3,
        policyEnabled: true, reapprovalRequired, cleanupPending: false, affectedMemberCount: 2 }],
    })
    return protectionRead(url)
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '审核继续接管' }))
  expect(screen.queryByRole('button', { name: '审核切换' })).toBeNull()
  expect(screen.getByText(/2 位项目成员尚无目标电脑/)).toBeTruthy()
  expect(mutations).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '确认继续' }))
  await screen.findByRole('button', { name: '审核切换' })
  expect(mutations).toEqual([{ url: '/admin/api/peer-backups/recoveries/' + attemptId + '/reapprove',
    body: { confirm: attemptId, policyRevision: 3, phase: 'old-fenced' } }])
})

it('waits for cancelled candidate cleanup before allowing another preparation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/recoveries?') ? Response.json({
    targets: [{ nodeId: target, volumeId: volumeA }],
    attempts: [{ id: attemptId, phase: 'cancelled', pointId, cleanupPending: true }],
  }) : protectionRead(url)))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  await screen.findByText(/正在清理已取消操作/)
  expect(screen.getByRole('button', { name: '准备替换电脑' }).hasAttribute('disabled')).toBe(true)
})

it('creates replacement protection for the same project without reusing its former source or credentials', async () => {
  const mutations: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') {
      mutations.push(JSON.parse(String(options.body)))
      return Response.json({})
    }
    if (url.includes('/recoveries?')) return Response.json({ targets: [], attempts: [{
      id: attemptId, phase: 'published', pointId, targetActivatedAt: new Date().toISOString(),
    }] })
    return protectionRead(url)
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '为新电脑配置保护' }))
  expect((screen.getByLabelText('源电脑') as HTMLSelectElement).value).toBe(target)
  expect((screen.getByLabelText('受保护范围') as HTMLSelectElement).value).toBe(source)
  expect((screen.getByLabelText(/追加凭据指纹/) as HTMLInputElement).value).toBe('')
  expect(mutations).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('备份电脑'), { target: { value: source } })
  fireEvent.change(screen.getByLabelText(/追加凭据指纹/), { target: { value: 'c'.repeat(64) } })
  fireEvent.change(screen.getByLabelText(/恢复凭据指纹/), { target: { value: 'd'.repeat(64) } })
  fireEvent.click(screen.getByRole('button', { name: '保存策略' }))
  await waitFor(() => expect(mutations).toEqual([expect.objectContaining({
    sourceNodeId: target, targetNodeId: source, scopeId: source, expectedRevision: 0,
    appendFingerprint: 'c'.repeat(64), recoveryFingerprint: 'd'.repeat(64),
  })]))
})
