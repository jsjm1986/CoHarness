import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeploymentNode } from '../api.ts'
import { PeerBackupSection } from './PeerBackupSection.tsx'
import { PendingEditsProvider } from '../pending-edits.tsx'
import { en as backupEn, zh as backupZh } from './peer-backup.copy.ts'

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(([
  ['peer-backup/source-capacity', 'sourceCapacityExhausted'],
  ['peer-backup/source-capacity-unavailable', 'sourceCapacityUnavailable'],
] as const).flatMap(([errorCode, key]) => (['zh', 'en'] as const).map(language => ({errorCode, key, language}))))('retains the policy and explains $errorCode in $language', async ({errorCode, key, language}) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ localWorkerConfigured: true, policies: [{
    policyId: '33333333-3333-4333-8333-333333333333', sourceNodeId: source, targetNodeId: target,
    scopeKind: 'project', scopeId: source, revision: 1, enabled: true, coverage: 'unprotected', errorCode,
  }] })))
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'coharness-admin-language' ? language : null })
  render(<PeerBackupSection nodes={[node(source, 'Source'), node(target, 'Receiver')]} />)
  expect((await screen.findByText((language === 'zh' ? backupZh : backupEn)[key])).getAttribute('role')).toBe('status')
  expect(screen.queryByText(errorCode)).toBeNull()
  expect(screen.getByRole('button', { name: language === 'zh' ? '恢复点与演练' : 'Recovery points and drills' })).toBeTruthy()
})

it('keeps a replacement read draft at its inspected revision and retains an unavailable explicit target',async()=>{
  const replacement='66666666-6666-4666-8666-666666666666',policy='33333333-3333-4333-8333-333333333333',point='44444444-4444-4444-8444-444444444444'
  let revision=1,available=true,revoked=false
  const requests:{url:string;body:Record<string,unknown>}[]=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    if(options?.method==='POST'){
      const body=JSON.parse(String(options.body)) as Record<string,unknown>;requests.push({url,body})
      if(url.endsWith('/recovery-access'))return Response.json({error:'peer-backup/recovery-access-changed'},{status:409})
      if(url.endsWith('/revoke'))revoked=true
      return Response.json({id:point})
    }
    if(url.includes('/recoveries?'))return Response.json({targets:available?[{nodeId:replacement,volumeId:replacement}]:[{nodeId:target,volumeId:source}],attempts:[]})
    if(url.endsWith('/recovery-access'))return Response.json({items:revoked?[]:[{id:source,pointId:point,recoveryNodeId:replacement,policyRevision:1,expiresAt:'2099-01-01T12:00:00Z',revokedAt:null}],maxLifetimeMs:3600000})
    if(url.endsWith('/points'))return Response.json({points:[{id:point,gapCount:0,coveredCount:3,protectedThrough:new Date().toISOString()}]})
    return Response.json({localWorkerConfigured:true,recoveryConfigured:true,policies:[{policyId:policy,sourceNodeId:source,targetNodeId:target,scopeKind:'project',scopeId:policy,revision,enabled:true,coverage:'current'}]})
  }))
  render(<PeerBackupSection nodes={[node(source,'Source'),node(target,'Receiver'),node(replacement,'Replacement')]}/> )
  fireEvent.click(await screen.findByRole('button',{name:'恢复点与演练'}))
  const selector=await screen.findByLabelText('独立演练电脑')
  fireEvent.change(selector,{target:{value:replacement}})
  const field=await screen.findByLabelText(/替代电脑读取凭据指纹/)
  fireEvent.change(field,{target:{value:'a'.repeat(64)}})
  const expires=screen.getByLabelText(/读取授权到期时间/)
  fireEvent.change(expires,{target:{value:'2099-01-01T12:00'}})
  fireEvent.click(screen.getByRole('button',{name:'撤销读取授权',hidden:true}))
  await waitFor(()=>expect(screen.queryByRole('button',{name:'撤销读取授权',hidden:true})).toBeNull())
  expect((field as HTMLInputElement).value).toBe('a'.repeat(64))
  expect((expires as HTMLInputElement).value).toBe('2099-01-01T12:00')
  revision=2;available=false
  fireEvent.click(screen.getByRole('button',{name:'刷新'}))
  await screen.findByRole('button',{name:'按当前策略重新审核'})
  expect((field as HTMLInputElement).value).toBe('a'.repeat(64))
  expect((expires as HTMLInputElement).value).toBe('2099-01-01T12:00')
  expect((selector as HTMLSelectElement).value).toBe(replacement)
  fireEvent.submit(screen.getByRole('form',{name:'替代电脑的备份读取授权',hidden:true}))
  await waitFor(()=>expect(requests.some(row=>row.url.endsWith('/recovery-access'))).toBe(true))
  expect(requests.find(row=>row.url.endsWith('/recovery-access'))!.body).toMatchObject({expectedRevision:1,recoveryNodeId:replacement,fingerprint:'a'.repeat(64)})
  await waitFor(()=>expect((screen.getByRole('button',{name:'授权此电脑读取备份',hidden:true}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.submit(screen.getByRole('form',{name:'替代电脑的备份读取授权',hidden:true}))
  await waitFor(()=>expect(requests.filter(row=>row.url.endsWith('/recovery-access'))).toHaveLength(2))
  const retries=requests.filter(row=>row.url.endsWith('/recovery-access'))
  expect(retries[1]!.body.id).toBe(retries[0]!.body.id)
  expect(screen.queryByRole('button',{name:'准备替换电脑'})).toBeNull()
  expect(requests.some(row=>row.url.endsWith('/recoveries'))).toBe(false)
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

it('shows overdue partial protection and stale receiver measurements, then retires only the reviewed repository', async () => {
  const policyId = '33333333-3333-4333-8333-333333333333', pointId = '44444444-4444-4444-8444-444444444444'
  const measuredAt = '2026-11-20T06:00:00Z'
  let approved = false
  const requests: { url:string; body:unknown }[] = []
  vi.stubGlobal('fetch',vi.fn(async (url:string,options?:RequestInit)=>{
    if (options?.method==='POST') {
      requests.push({url,body:JSON.parse(String(options.body))})
      approved = true
      return Response.json({approved:true},{status:202})
    }
    return Response.json({localWorkerConfigured:true,policies:[{
      policyId,sourceNodeId:source,targetNodeId:target,scopeKind:'project',scopeId:target,revision:3,enabled:!approved,
      coverage:'partial',freshness:'overdue',protectedThrough:measuredAt,coveredCount:3,gapCount:1,captureStoppedAt:measuredAt,
      receiverCapacity:{used:1024,remaining:0,receiverUsed:1048576,receiverLimit:1048576,remainingObjects:3,
        measuredAt,reason:'receiver-capacity'},receiverCapacityStale:true,
      retirementPending:approved,retirementCandidate:approved?null:{pointId,policyId:source,targetNodeId:target,protectedThrough:measuredAt},
    }]})
  }))
  render(<PeerBackupSection nodes={[node(source,'Source'),node(target,'Receiver')]} />)
  expect(await screen.findByText(backupZh.backupFreshnessOverdue)).toBeTruthy()
  expect(screen.getByText(/容量数据已过期/)).toBeTruthy()
  expect(screen.getByText(/可追加 0 KiB/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:backupZh.reviewRepositoryRetirement}))
  const dialog = screen.getByRole('dialog',{name:backupZh.reviewRepositoryRetirement})
  expect(dialog.textContent).toContain(pointId)
  expect(requests).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button',{name:backupZh.retireRepository}))
  await waitFor(()=>expect(requests).toEqual([{
    url:'/admin/api/peer-backups/'+policyId+'/retire',body:{confirm:policyId,revision:3,pointId},
  }]))
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
function protectionRead(url: string, scopeKind = 'project', gapCount = 0) {
  return Response.json(url.endsWith('/points') ? {
    points: [{ id: pointId, gapCount, coveredCount: 3, protectedThrough: new Date().toISOString() }],
  } : { localWorkerConfigured: true, recoveryConfigured: true, policies: [{ ...protectedPolicy, scopeKind, gapCount }] })
}

it('records explicit disaster isolation against the inspected source generation without persisting evidence in the browser', async () => {
  const mutations: Array<{ url: string; body: unknown }> = []
  let phase = 'prepared'
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      mutations.push({ url, body: JSON.parse(String(options.body)) })
      phase = 'externally-fenced'
      return Response.json({ id: attemptId })
    }
    if (url.includes('/recoveries?')) return Response.json({ targets: [{ nodeId: target, volumeId: volumeA }],
      attempts: [{ id: attemptId, phase, pointId, policyRevision: 3, currentPolicyRevision: 3,
        policyEnabled: true, reapprovalRequired: false, recoveryMode: 'disaster', sourceNodeId: source,
        sourceGeneration: '7', sourceEpoch: '4' }],
    })
    return protectionRead(url)
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '记录原电脑隔离' }))
  const submit = screen.getByRole('button', { name: '确认隔离并准备恢复' })
  expect(submit.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/影响它承载的所有空间/)).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: /^隔离证据编号或记录位置/ }), { target: { value: 'ticket/DR-17' } })
  fireEvent.change(screen.getByLabelText('隔离方式'), { target: { value: 'network-isolation' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核实原电脑无法继续执行任务或对外写入' }))
  expect(submit.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '我接受恢复点后的数据缺口，并将核对任务执行结果' }))
  expect(mutations).toHaveLength(0)
  fireEvent.click(submit)
  await waitFor(() => expect(mutations).toEqual([{ url: '/admin/api/peer-backups/recoveries/' + attemptId + '/confirm-isolation',
    body: { confirm: attemptId, policyRevision: 3, sourceNodeId: source, sourceGeneration: '7', sourceEpoch: '4',
      pointId, isolationMethod: 'network-isolation', evidenceReference: 'ticket/DR-17', acknowledgeDataLoss: true } }]))
  await screen.findByText('原电脑已隔离，正在准备替换数据')
  expect(storage.mock.calls.some(([, value]) => value.includes('ticket/DR-17'))).toBe(false)
  storage.mockRestore()
})

it.each(['project', 'personal'] as const)('retains a %s isolation form on refresh and refuses a changed source generation until reviewed again', async scopeKind => {
  let sourceGeneration = '7'
  const mutations: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') mutations.push(options.body)
    if (url.includes(scopeKind === 'personal' ? '/personal-recoveries?' : '/recoveries?')) return Response.json({ targets: [{ nodeId: target, volumeId: volumeA }],
      attempts: [{ id: attemptId, phase: 'prepared', pointId, policyRevision: 3, currentPolicyRevision: 3,
        policyEnabled: true, reapprovalRequired: false, recoveryMode: 'disaster', sourceNodeId: source,
        sourceGeneration, sourceEpoch: '4' }],
    })
    return protectionRead(url, scopeKind)
  }))
  render(<PendingEditsProvider><PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} /></PendingEditsProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '记录原电脑隔离' }))
  fireEvent.change(screen.getByRole('textbox', { name: /^隔离证据编号或记录位置/ }), { target: { value: 'ticket/DR-18' } })
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  const keep = screen.getByRole('dialog', { name: '保留当前编辑' })
  fireEvent.click(within(keep).getByRole('button', { name: '留在当前页面' }))
  expect((screen.getByRole('textbox', { name: /^隔离证据编号或记录位置/ }) as HTMLInputElement).value).toBe('ticket/DR-18')
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核实原电脑无法继续执行任务或对外写入' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '我接受恢复点后的数据缺口，并将核对任务执行结果' }))
  sourceGeneration = '8'
  fireEvent.click(screen.getByRole('button', { name: '刷新接管状态' }))
  await screen.findByText('接管状态或策略已变化，请刷新后重新审核。')
  expect((screen.getByRole('textbox', { name: /^隔离证据编号或记录位置/ }) as HTMLInputElement).value).toBe('ticket/DR-18')
  expect(screen.getByRole('button', { name: '确认隔离并准备恢复' }).hasAttribute('disabled')).toBe(true)
  expect(mutations).toHaveLength(0)
})

it('prepares a disaster operation only after the administrator selects that recovery method', async () => {
  const mutations: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      mutations.push(JSON.parse(String(options.body)))
      return Response.json({ operationId: attemptId })
    }
    if (url.includes('/recoveries?')) return Response.json({ targets: [{ nodeId: target, volumeId: volumeA }], attempts: [] })
    return protectionRead(url)
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  const method = await screen.findByLabelText('恢复方式')
  expect((method as HTMLSelectElement).value).toBe('planned')
  fireEvent.change(method, { target: { value: 'disaster' } })
  expect(mutations).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '准备替换电脑' }))
  await waitFor(() => expect(mutations).toEqual([expect.objectContaining({
    policyId, pointId, targetNode: target, targetVolume: volumeA, recoveryMode: 'disaster',
  })]))
})

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


it.each(['planned', 'disaster'] as const)('opens execution review for an activated %s recovery with a retained hold', async recoveryMode => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/execution')) return Response.json({ recoveryMode, phase: 'published',
      status: 'unprepared', preparationStatus: 'idle', oldSessionCount: null, reviewRevision: null,
      tasksSuspended: true, sessionsReadOnly: true, items: [], blockers: [], errorCode: null })
    if (url.includes('/recoveries?')) return Response.json({ targets: [], attempts: [{
      id: attemptId, phase: 'published', pointId, targetActivatedAt: new Date().toISOString(),
      recoveryMode, executionReviewRequired: true, executionPolicyTransferRequired: recoveryMode === 'planned',
    }] })
    return protectionRead(url)
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  expect(await screen.findByRole('button', { name: '检查恢复后的运行配置' })).toBeTruthy()
  if (recoveryMode === 'planned') expect(screen.getByText(/此次计划迁移会保留旧对话/)).toBeTruthy()
})

it('validates a personal point before offering isolation and sends only the personal recovery request fields', async () => {
  const mutations: Array<{ url: string; body: unknown }> = []
  let requested = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      mutations.push({ url, body: JSON.parse(String(options.body)) })
      requested = true
      return Response.json({ operationId: attemptId }, { status: 202 })
    }
    if (url.includes('/personal-recoveries?')) return Response.json({ targets: [{ nodeId: target, volumeId: volumeA }],
      attempts: requested ? [{ id: attemptId, phase: 'preparing', pointId, recoveryMode: 'disaster',
        policyRevision: 3, currentPolicyRevision: 3, policyEnabled: true, reapprovalRequired: false }] : [] })
    return protectionRead(url, 'personal')
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '准备替换电脑' }))
  await screen.findByText('正在目标电脑校验个人数据、文档和运行配置；完成前不能确认隔离。')
  expect(mutations).toEqual([{ url: '/admin/api/peer-backups/personal-recoveries', body: {
    requestId: expect.any(String), policyId, pointId, targetNode: target, targetVolume: volumeA,
  } }])
  expect(screen.queryByLabelText('恢复方式')).toBeNull()
  expect(screen.queryByRole('button', { name: '记录原电脑隔离' })).toBeNull()
  expect(screen.queryByRole('button', { name: '检查恢复后的运行配置' })).toBeNull()
  expect(screen.getByRole('button', { name: '取消接管' })).toBeTruthy()
})

it('keeps an incomplete personal point available for a drill but prevents requesting replacement', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/personal-recoveries?')
    ? Response.json({ targets: [{ nodeId: target, volumeId: volumeA }], attempts: [] })
    : protectionRead(url, 'personal', 1)))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  expect((await screen.findByRole('button', { name: '准备替换电脑' })).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '开始隔离演练' }).hasAttribute('disabled')).toBe(false)
})

it.each([
  ['personal-session-platform-unsupported', '此恢复点的旧会话路径与目标操作系统不兼容，请选择相同操作系统的电脑恢复。'],
  ['personal-owner-unavailable', '请先确认该账号仍有效，并有目标电脑的使用权限；恢复不会自动扩大权限。'],
  ['personal-target-busy', '此账号在目标电脑上仍有运行中或状态未确认的 Runtime。请在任务安全结束后再继续，恢复不会自动停止它们。'],
  ['recovery-worker-unavailable', '替代电脑尚未提供此范围的恢复服务。请升级并完成项目内容库或个人恢复配置，再重新检查；已有数据和任务保持不变。'],
])('explains personal preparation failure %s without offering isolation or execution', async (code, text) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/personal-recoveries?')
    ? Response.json({ targets: [], attempts: [{ id: attemptId, pointId, phase: 'preparing', recoveryMode: 'disaster',
      lastError: 'peer-backup/' + code }] }) : protectionRead(url, 'personal')))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  expect(await screen.findByText('最近一次核验 · ' + text)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '记录原电脑隔离' })).toBeNull()
  expect(screen.queryByRole('button', { name: '检查恢复后的运行配置' })).toBeNull()
})

it('confirms exact personal isolation then waits for target publication before opening execution review', async () => {
  const mutations: Array<{ url: string; body: unknown }> = []
  const reads: string[] = []
  let phase = 'prepared'
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      mutations.push({ url, body: JSON.parse(String(options.body)) })
      phase = url.endsWith('/confirm-isolation') ? 'externally-fenced' : 'activating'
      return Response.json({ operationId: attemptId }, { status: 202 })
    }
    reads.push(url)
    if (url.includes('/personal-recoveries?')) return Response.json({ targets: [{ nodeId: target, volumeId: volumeA }],
      attempts: [{ id: attemptId, phase, pointId, recoveryMode: 'disaster', policyRevision: 3,
        currentPolicyRevision: 3, policyEnabled: phase !== 'published', reapprovalRequired: phase === 'published', sourceNodeId: source,
        sourceGeneration: '7', sourceEpoch: '4', schedulesSuspended: true, suspendedEnvironmentKeys: ['HGW_DATABASE_URL', 'PGPASSWORD'],
        targetActivatedAt: phase === 'published' ? '2026-11-16T00:00:00Z' : null,
        executionReviewRequired: phase === 'published' }] })
    if (url.endsWith('/execution')) return Response.json({ recoveryMode: 'disaster', phase: 'published',
      status: 'unprepared', preparationStatus: 'idle', oldSessionCount: null, reviewRevision: null,
      tasksSuspended: true, sessionsReadOnly: true, items: [], blockers: [], errorCode: null })
    return protectionRead(url, 'personal')
  }))
  render(<PeerBackupSection nodes={[node(source, 'Mac'), node(target, 'Windows')]} />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复点与演练' }))
  fireEvent.click(await screen.findByRole('button', { name: '记录原电脑隔离' }))
  expect(screen.getByText('已暂停的连接与运行环境设置（2）')).toBeTruthy()
  expect(screen.getByText('HGW_DATABASE_URL')).toBeTruthy()
  expect(screen.getByText('PGPASSWORD')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: /^隔离证据编号或记录位置/ }), { target: { value: 'ticket/personal-1' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核实原电脑无法继续执行任务或对外写入' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '我接受恢复点后的数据缺口，并将核对任务执行结果' }))
  fireEvent.click(screen.getByRole('button', { name: '确认隔离并准备恢复' }))
  fireEvent.click(await screen.findByRole('button', { name: '审核切换' }))
  expect(screen.getByText(/确认将此个人 Runtime 和对应账号文档的归属切换至 Windows/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  await screen.findByText('正在切换归属')
  expect(mutations).toEqual([
    { url: '/admin/api/peer-backups/personal-recoveries/' + attemptId + '/confirm-isolation', body: {
      confirm: attemptId, policyRevision: 3, sourceNodeId: source, sourceGeneration: '7', sourceEpoch: '4', pointId,
      isolationMethod: 'power-off', evidenceReference: 'ticket/personal-1', acknowledgeDataLoss: true,
    } },
    { url: '/admin/api/peer-backups/personal-recoveries/' + attemptId + '/activate', body: { confirm: attemptId } },
  ])
  expect(screen.queryByRole('button', { name: '检查恢复后的运行配置' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消接管' })).toBeNull()
  phase = 'published'
  fireEvent.click(screen.getByRole('button', { name: '刷新接管状态' }))
  await screen.findByRole('button', { name: '检查恢复后的运行配置' })
  expect(reads).toContain('/admin/api/peer-backups/personal-recoveries/' + attemptId + '/execution')
  expect(screen.getByText('个人数据已在替换电脑恢复。请另建备份策略，保护新电脑上的 Runtime 和账号文档。')).toBeTruthy()
  expect(screen.queryByText(/策略已暂停/)).toBeNull()
})
