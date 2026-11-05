/** Organization-scoped online protection choices. Credentials never enter the form or browser storage. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeploymentNode } from '../api.ts'
import { adminLanguage } from '../language.ts'
import { Button, ErrorBanner, Field, Section, StatusBadge } from '../components/ui.tsx'

interface Policy {
  policyId: string
  scopeId: string
  scopeKind: Kind
  sourceNodeId: string
  targetNodeId: string
  revision: number
  enabled: boolean
  tier: 'important' | 'ordinary'
  quotaBytes: number
  appendFingerprint: string
  recoveryFingerprint: string
  coverage: 'current' | 'partial' | 'overdue' | 'unprotected'
  protectedThrough: string | null
  pendingBytes: number | null
  repositoryBytes?: number | null
  availableBytes?: number | null
  coveredCount: number | null
  gapCount: number | null
  gapTypes?: string[]
  jobStatus: string | null
  errorCode: string | null
  lastDrillAt: string | null
  drillStatus: string | null
  recoveryMs?: number | null
}
type Kind = 'project' | 'personal' | 'governance'
interface Point {
  id: string
  protectedThrough: string
  gapCount: number
  coveredCount: number
}
interface Choice {
  id: string
  publicId: string
}
const base = '/admin/api/peer-backups'
async function api<T>(suffix: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + suffix, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  })
  const result = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? String(response.status))
  return result
}
const err = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const date = (value: string | null): string => (value ? new Date(value).toLocaleString() : '—')

/** Render within the existing primary deployment page after its entry scope is known. */
export function PeerBackupSection({ nodes }: { nodes: readonly DeploymentNode[] }) {
  const zh = adminLanguage() === 'zh'
  const t = (cn: string, en: string): string => (zh ? cn : en)
  const [policies, setPolicies] = useState<Policy[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false)
  const [localWorker, setLocalWorker] = useState<{ configured: boolean; recovery?: boolean; error?: string }>()
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false),
    [original, setOriginal] = useState<Policy | null>(null),
    [reprotecting, setReprotecting] = useState(false)
  const [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [kind, setKind] = useState<Kind>('project'),
    [scope, setScope] = useState('')
  const [choices, setChoices] = useState<Choice[]>([]),
    [moreChoices, setMoreChoices] = useState(false)
  const [tier, setTier] = useState<Policy['tier']>('important'),
    [quota, setQuota] = useState('1024'),
    [enabled, setEnabled] = useState(true)
  const [append, setAppend] = useState(''),
    [recover, setRecover] = useState('')
  const [selected, setSelected] = useState<Policy | null>(null),
    [points, setPoints] = useState<Point[]>([]),
    [point, setPoint] = useState(''),
    [replacement, setReplacement] = useState('')
  const alive = useRef(true),
    read = useRef<AbortController | null>(null)
  const name = (id: string): string => nodes.find((n) => n.nodeId === id)?.name ?? id
  const refresh = useCallback(async (after = '') => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    setLoading(true)
    try {
      const result = await api<{
        policies: Policy[]
        localWorkerConfigured: boolean
        recoveryConfigured?: boolean
        localWorkerError?: string
      }>('?after=' + encodeURIComponent(after), 'GET', undefined, controller.signal)
      if (!controller.signal.aborted) {
        setLocalWorker({
          configured: result.localWorkerConfigured,
          recovery: result.recoveryConfigured,
          error: result.localWorkerError,
        })
        setPolicies((old) => (after ? [...old, ...result.policies] : result.policies))
        setMore(result.policies.length === 50)
        setError('')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(err(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      read.current?.abort()
    }
  }, [refresh])
  useEffect(() => {
    if (!selected) {
      setPoints([])
      return
    }
    setPoints([])
    setPoint('')
    const ctl = new AbortController()
    void api<{ points: Point[] }>('/' + selected.policyId + '/points', 'GET', undefined, ctl.signal)
      .then((result) => {
        if (!ctl.signal.aborted) {
          setPoints(result.points)
          setPoint(result.points[0]?.id ?? '')
        }
      })
      .catch((cause) => {
        if (!ctl.signal.aborted) setError(err(cause))
      })
    return () => ctl.abort()
  }, [selected])
  useEffect(() => {
    if (!editing || !source || original || reprotecting) return
    const ctl = new AbortController()
    setChoices([])
    setScope('')
    setMoreChoices(false)
    void api<{ scopes: Choice[] }>('/scopes?source=' + source + '&kind=' + kind, 'GET', undefined, ctl.signal)
      .then((result) => {
        if (!ctl.signal.aborted) {
          setChoices(result.scopes)
          setScope(result.scopes[0]?.id ?? '')
          setMoreChoices(result.scopes.length === 100)
        }
      })
      .catch((cause) => {
        if (!ctl.signal.aborted) setError(err(cause))
      })
    return () => ctl.abort()
  }, [source, kind, editing, original, reprotecting])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(err(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  function edit(row: Policy | null) {
    setSelected(null)
    setReprotecting(false)
    setOriginal(row)
    setSource(row?.sourceNodeId ?? nodes[0]?.nodeId ?? '')
    setTarget(row?.targetNodeId ?? '')
    setKind(row?.scopeKind ?? 'project')
    setScope(row?.scopeId ?? '')
    setQuota(String((row?.quotaBytes ?? 1024 * 1024 * 1024) / (1024 * 1024)))
    setEnabled(row?.enabled ?? true)
    setTier(row?.tier ?? 'important')
    setAppend(row?.appendFingerprint ?? '')
    setRecover(row?.recoveryFingerprint ?? '')
    setEditing(true)
  }
  function protectReplacement(row: Policy) {
    edit(null)
    setReprotecting(true)
    setSource(row.targetNodeId)
    setKind(row.scopeKind)
    setScope(row.scopeId)
    setChoices([{ id: row.scopeId, publicId: row.scopeId }])
  }
  const message = (value: string) => {
    const labels: Record<string, string> = {
      'peer-backup/coverage-incomplete': t('此恢复点有未保护的数据。', 'This point has uncovered data.'),
      'peer-backup/isolated-recovery-only': t(
        '此范围支持隔离恢复。正式发布需要独立的恢复流程。',
        'This scope supports isolated recovery. Returning it to service requires a separate recovery procedure.',
      ),
      'peer-backup/independent-drill-required': t(
        '请先在另一台电脑演练此恢复点。',
        'Rehearse this point on a different computer.',
      ),
      'peer-backup/verified-writer-fence-required': t(
        '正式接管前须核验旧写入端已隔离。',
        'Verify isolation of the previous writer before promotion.',
      ),
      'peer-backup/provisioning-required': t(
        '请配置本机的策略路由与独立凭据。',
        'Provision the policy route and credentials on this computer.',
      ),
      'peer-backup/revision-conflict': t('策略已更改，请刷新并重新核对。', 'Refresh and review the updated policy.'),
      'peer-backup/recovery-in-progress': t(
        '接管尚未完成。请先完成或取消接管，再修改配额或恢复点目标。',
        'Complete or cancel the takeover before changing its quota or recovery objective.',
      ),
      'peer-backup/invalid-configuration': t('请核对本机备份配置。', 'Review the backup configuration on this computer.'),
      'peer-backup/personal-directory-unpublished': t(
        '此 Runtime 尚未发布本机个人目录。',
        'This Runtime has not published a local personal directory.',
      ),
      queued: t('排队中', 'Queued'),
      running: t('进行中', 'Running'),
      confirmed: t('已核验', 'Verified'),
      failed: t('失败', 'Failed'),
    }
    return labels[value] ?? value
  }
  const coverage = {
    current: t('符合目标', 'Current'),
    partial: t('部分保护', 'Partial'),
    overdue: t('超出目标', 'Overdue'),
    unprotected: t('尚无恢复点', 'No recovery point'),
  }
  return (
    <Section
      title={t('异机加密备份', 'Encrypted peer backups')}
      actions={
        <>
          <Button disabled={loading || busy} onClick={() => void refresh()}>
            {t('刷新', 'Refresh')}
          </Button>{' '}
          <Button disabled={busy || editing || nodes.length < 2} onClick={() => edit(null)}>
            {t('添加策略', 'Add policy')}
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      {notice && <p role="status">{notice}</p>}
      {!policies.length && !editing && (
        <p className="fieldHint">
          {loading
            ? t('正在读取备份策略…', 'Loading backup policies…')
            : t(
                '为一个空间指定另一台受管电脑，开始后台加密保护。',
                'Choose another managed computer to protect a space in the background.',
              )}
        </p>
      )}
      {policies.map((row) => (
        <div key={row.policyId} className="detailBlock">
          <div className="statusRow">
            <strong>
              {name(row.sourceNodeId)} → {name(row.targetNodeId)}
            </strong>
            <StatusBadge tone={row.coverage === 'current' ? 'success' : row.coverage === 'overdue' ? 'warning' : 'neutral'}>
              {row.enabled ? coverage[row.coverage] : t('已暂停', 'Paused')}
            </StatusBadge>
          </div>
          <p>
            {t('范围', 'Scope')} {row.scopeKind} · {row.scopeId} ·{' '}
            {row.tier === 'important' ? t('15 分钟', '15 min') : t('1 小时', '1 hour')}
          </p>
          <p>
            {t('已保护到', 'Protected through')} {date(row.protectedThrough)} · {t('覆盖项', 'Covered')}{' '}
            {row.coveredCount ?? '—'} · {t('缺口', 'Gaps')} {row.gapCount ?? '—'}
          </p>
          {row.gapTypes?.length ? (
            <p>
              {t('待覆盖', 'Pending coverage')} ·{' '}
              {row.gapTypes
                .map(
                  (gap) =>
                    ({
                      files: t('文件', 'Files'),
                      plugins: t('插件数据', 'Plugin data'),
                      database: t('内容库', 'Content database'),
                      unknown: t('待核对数据', 'Unclassified data'),
                    })[gap] ?? gap,
                )
                .join('、')}
            </p>
          ) : null}
          {row.jobStatus && (
            <p>
              {t('后台操作', 'Background operation')} · {row.jobStatus}
            </p>
          )}
          <p>
            {t('待处理量', 'Pending')} {row.pendingBytes === null ? '—' : Math.ceil(row.pendingBytes / 1024) + ' KiB'} ·{' '}
            {t('最近演练', 'Latest rehearsal')} {date(row.lastDrillAt)} {row.drillStatus ? message(row.drillStatus) : ''}{' '}
            {row.recoveryMs != null ? (row.recoveryMs / 1000).toFixed(1) + ' s' : ''}
          </p>
          {row.repositoryBytes != null && row.availableBytes != null && (
            <p className="muted">
              {t('上次接收时已用', 'Last measured storage')} {Math.ceil(row.repositoryBytes / 1048576)} MiB ·{' '}
              {t('可用', 'available')} {Math.floor(row.availableBytes / 1048576)} MiB
            </p>
          )}
          <details>
            <summary>{t('部署标识', 'Deployment identity')}</summary>
            <code>{row.policyId}</code>
          </details>
          {row.errorCode && <p role="status">{message(row.errorCode)}</p>}
          <div className="formActions">
            <Button
              disabled={busy || !row.enabled}
              onClick={() =>
                void run(async () => {
                  await api('/' + row.policyId + '/capture', 'POST', {})
                  setNotice(t('已加入后台队列。', 'Queued for background capture.'))
                  await refresh()
                })
              }
            >
              {t('立即备份', 'Back up now')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setSelected(row)
                setReplacement(row.targetNodeId)
              }}
            >
              {t('恢复点与演练', 'Recovery points and drills')}
            </Button>
            <Button disabled={busy} onClick={() => edit(row)}>
              {t('编辑策略', 'Edit policy')}
            </Button>
          </div>
        </div>
      ))}
      {localWorker && (!localWorker.configured || localWorker.error) && (
        <p role="status">
          {localWorker.error
            ? message(localWorker.error)
            : t(
                '本机尚未配置备份服务。可先保存策略，再按部署说明配置。',
                'Configure the local backup service after saving the policy.',
              )}
        </p>
      )}
      {more && (
        <Button disabled={loading || busy} onClick={() => void refresh(policies[policies.length - 1]!.policyId)}>
          {t('更多策略', 'More policies')}
        </Button>
      )}
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await api('', 'PUT', {
                id: original?.policyId ?? crypto.randomUUID(),
                expectedRevision: original?.revision ?? 0,
                scopeKind: kind,
                scopeId: scope,
                sourceNodeId: source,
                targetNodeId: target,
                tier,
                enabled,
                quotaBytes: Number(quota) * 1024 * 1024,
                appendFingerprint: append,
                recoveryFingerprint: recover,
              })
              setEditing(false)
              setNotice(t('备份策略已保存。', 'Backup policy saved.'))
              await refresh()
            })
          }}
        >
          {reprotecting && <p role="status">{t(
            '正在为已接管的项目建立新策略。请选择另一台接收电脑并配置新的凭据。',
            'Protect the transferred project with a new policy. Choose another receiver and provision new credentials.',
          )}</p>}
          <Field label={t('源电脑', 'Source computer')}>
            <select
              className="input"
              required
              disabled={!!original || reprotecting || busy}
              value={source}
              onChange={(e) => {
                setSource(e.target.value)
                setTarget('')
              }}
            >
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('备份电脑', 'Backup computer')}>
            <select
              className="input"
              required
              disabled={!!original || busy}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{t('选择电脑', 'Select computer')}</option>
              {nodes
                .filter((n) => n.nodeId !== source)
                .map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('保护类型', 'Protected type')}>
            <select
              className="input"
              disabled={!!original || reprotecting || busy}
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option value="project">{t('协作项目', 'Project space')}</option>
              <option value="personal">{t('个人 Runtime', 'Personal Runtime')}</option>
              <option value="governance">{t('组织治理库', 'Governance database')}</option>
            </select>
          </Field>
          <Field label={t('受保护范围', 'Protected scope')}>
            <select
              className="input"
              required
              disabled={!!original || reprotecting || busy}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {original ? (
                <option value={scope}>{scope}</option>
              ) : (
                choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {kind === 'governance'
                      ? t('组织治理库', 'Governance database')
                      : '#' + c.publicId + ' · ' + c.id.slice(0, 8)}
                  </option>
                ))
              )}
            </select>
          </Field>
          {moreChoices && !original && !reprotecting && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ scopes: Choice[] }>(
                    '/scopes?source=' + source + '&kind=' + kind + '&after=' + choices[choices.length - 1]!.id,
                  )
                  setChoices([...choices, ...r.scopes])
                  setMoreChoices(r.scopes.length === 100)
                })
              }
            >
              {t('更多空间', 'More spaces')}
            </Button>
          )}
          <Field label={t('恢复点目标', 'Recovery point objective')}>
            <select className="input" value={tier} onChange={(e) => setTier(e.target.value as Policy['tier'])}>
              <option value="important">{t('重要 · 15 分钟', 'Important · 15 min')}</option>
              <option value="ordinary">{t('普通 · 1 小时', 'Ordinary · 1 hour')}</option>
            </select>
          </Field>
          <Field label={t('仓库配额（MiB）', 'Repository quota (MiB)')}>
            <input
              className="input"
              type="number"
              required
              min="1"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
            />
          </Field>
          <Field label={t('追加凭据指纹（SHA-256）', 'Append credential fingerprint (SHA-256)')}>
            <input
              className="input"
              autoComplete="off"
              required
              pattern="[a-f0-9]{64}"
              value={append}
              onChange={(e) => setAppend(e.target.value)}
            />
          </Field>
          <Field label={t('恢复凭据指纹（SHA-256）', 'Recovery credential fingerprint (SHA-256)')}>
            <input
              className="input"
              autoComplete="off"
              required
              pattern="[a-f0-9]{64}"
              value={recover}
              onChange={(e) => setRecover(e.target.value)}
            />
          </Field>
          <label className="checkLabel">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('启用此策略', 'Enable policy')}
          </label>
          <div className="formActions">
            <Button type="submit" variant="primary" disabled={busy || !scope || !target || append === recover}>
              {t('保存策略', 'Save policy')}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setEditing(false)}>
              {t('取消', 'Cancel')}
            </Button>
          </div>
        </form>
      )}
      {selected && (
        <div className="detailBlock">
          <Field label={t('恢复点', 'Recovery point')}>
            <select className="input" value={point} onChange={(e) => setPoint(e.target.value)}>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {date(p.protectedThrough)} · {t('缺口', 'Gaps')} {p.gapCount}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('独立演练电脑', 'Independent rehearsal computer')}>
            <select className="input" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
              {nodes
                .filter((n) => n.nodeId !== selected.sourceNodeId)
                .map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Field>
          {localWorker?.recovery && selected.scopeKind === 'project' && point && (
            <PeerRecoveryActions
              key={selected.policyId + '/' + point}
              policy={selected}
              point={points.find((row) => row.id === point)!}
              nodeName={nodes.find((node) => node.nodeId === selected.targetNodeId)?.name ?? selected.targetNodeId}
              t={t}
              onReprotect={() => protectReplacement(selected)}
            />
          )}
          <div className="formActions">
            <Button
              disabled={busy || !point || !replacement}
              onClick={() =>
                void run(async () => {
                  await api('/' + selected.policyId + '/drill', 'POST', { pointId: point, recoveryNodeId: replacement })
                  setNotice(t('隔离恢复演练已入队。', 'Isolated recovery drill queued.'))
                  await refresh()
                })
              }
            >
              {t('开始隔离演练', 'Start isolated drill')}
            </Button>
            <Button
              disabled={busy || !point || !replacement}
              onClick={() =>
                void run(async () => {
                  const check = await api<{ blockers: string[] }>('/' + selected.policyId + '/preflight', 'POST', {
                    pointId: point,
                    recoveryNodeId: replacement,
                  })
                  setNotice(check.blockers.map(message).join(' '))
                })
              }
            >
              {t('恢复预检', 'Recovery preflight')}
            </Button>
            <Button disabled={busy} onClick={() => setSelected(null)}>
              {t('关闭', 'Close')}
            </Button>
          </div>
        </div>
      )}
    </Section>
  )
}

interface RecoveryAttempt {
  id: string
  phase: string
  pointId: string
  lastError?: string | null
  targetActivatedAt?: string | null
  policyRevision: number
  currentPolicyRevision: number
  policyEnabled: boolean
  reapprovalRequired: boolean
  cleanupPending: boolean
  affectedMemberCount?: number
}
interface RecoveryOptions {
  targets: { nodeId: string; volumeId: string }[]
  attempts: RecoveryAttempt[]
}

function PeerRecoveryActions({
  policy,
  point,
  nodeName,
  t,
  onReprotect,
}: {
  policy: Policy
  point: Point
  nodeName: string
  t: (cn: string, en: string) => string
  onReprotect: () => void
}) {
  const [options, setOptions] = useState<RecoveryOptions>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(''),
    [volume, setVolume] = useState('')
  const alive = useRef(false),
    generation = useRef(0)
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++generation.current
      const data = await api<RecoveryOptions>(
        '/recoveries?policyId=' + encodeURIComponent(policy.policyId),
        'GET',
        undefined,
        signal,
      )
      if (alive.current && !signal?.aborted && request === generation.current) setOptions(data)
    },
    [policy.policyId],
  )
  useEffect(() => {
    alive.current = true
    const lifetime = new AbortController()
    void refresh(lifetime.signal).catch((cause) => {
      if (!lifetime.signal.aborted) setError(err(cause))
    })
    return () => {
      alive.current = false
      lifetime.abort()
    }
  }, [refresh])
  const current = options?.attempts.find(
    (attempt) => attempt.phase !== 'cancelled' && (!attempt.targetActivatedAt || attempt.pointId === point.id),
  )
  const paired = options?.targets.filter((target) => target.nodeId === policy.targetNodeId) ?? []
  const selectedVolume = paired.some((target) => target.volumeId === volume)
    ? volume : paired.length === 1 ? paired[0]!.volumeId : ''
  const cleanupPending = options?.attempts.some((attempt) => attempt.cleanupPending)
  const labels: Record<string, string> = {
    prepared: t('正在准备替换电脑', 'Preparing replacement'),
    'target-ready': t('替换电脑已验证', 'Replacement verified'),
    'retire-approved': t('等待原电脑确认停止', 'Waiting for source to confirm it has stopped'),
    retiring: t('正在封存原写入端', 'Fencing source writer'),
    'old-fenced': t('原写入端已封存', 'Source writer fenced'),
    switching: t('正在切换归属', 'Switching ownership'),
    published: current?.targetActivatedAt
      ? t('替换电脑已接管', 'Replacement is serving')
      : t('等待替换电脑最后核验', 'Waiting for final verification'),
  }
  const problem = (code: string): string => ({
    'peer-backup/current-revision-drill-required': t('请先按当前策略在目标电脑演练原恢复点。',
      'Rehearse the original recovery point on the target under the current policy.'),
    'peer-backup/recovery-approval-changed': t('接管状态或策略已变化，请刷新后重新审核。',
      'The takeover or policy changed. Refresh and review it again.'),
    'peer-backup/project-owner-unavailable': t('请核对项目所有者的账号、项目成员资格及目标电脑使用权限。',
      'Check the project owner’s account, project membership and target computer access.'),
    'peer-backup/recovery-cleanup-pending': t('请等待已取消候选清理完成后重新准备。',
      'Wait for cancelled candidate cleanup before preparing another replacement.'),
    'peer-backup/recovery-in-progress': t('接管尚未完成，请先完成或取消接管。',
      'Complete or cancel the active takeover first.'),
  })[code] ?? code
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      if (alive.current) {
        setConfirm('')
        await refresh()
      }
    } catch (cause) {
      if (alive.current) setError(err(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const operate = (action: string) =>
    current && api('/recoveries/' + current.id + '/' + action, 'POST', { confirm: current.id })
  const step = current?.reapprovalRequired ? undefined :
    current?.phase === 'target-ready' ? 'approve-retirement' : current?.phase === 'old-fenced' ? 'activate' : undefined
  const help =
    step === 'approve-retirement'
      ? t(
          '确认后，原电脑会核验所有文件和待投递任务。成功封存后，原电脑不能继续写入此项目。',
          'Confirm to verify files and pending deliveries. Once fenced, the source can no longer write this project.',
        )
      : t(
          '确认将项目和原 Runtime 的归属切换至 ' + nodeName + '。',
          'Confirm transfer of the project and its existing Runtime to ' + nodeName + '.',
        )
  return (
    <div className="detailBlock">
      <strong>{t('项目接管', 'Project takeover')}</strong>
      <p>{current ? labels[current.phase] : t('目标电脑', 'Replacement computer') + ' · ' + nodeName}</p>
      {current && current.pointId !== point.id && <p role="status">{t(
        '此策略已有另一恢复点的接管操作。请完成或取消该操作后再准备当前恢复点。',
        'Another recovery point already has an active takeover. Complete or cancel it before preparing this point.',
      )}</p>}
      {!!current?.affectedMemberCount && <p role="status">{t(
        `${current.affectedMemberCount} 位项目成员尚无目标电脑使用权限。接管不会扩大权限，请在用户权限页单独授权。`,
        `${current.affectedMemberCount} project members lack target computer access. Grant access separately in user permissions; takeover does not expand permissions.`,
      )}</p>}
      {cleanupPending && <p role="status">{t(
        '正在清理已取消操作创建的候选数据，原项目仍保留。清理完成后可重新准备。',
        'Removing the cancelled candidate. The original project is retained. Preparation is available after cleanup.',
      )}</p>}
      {current?.reapprovalRequired && <div role="status">
        <p>{current.policyEnabled ? t(
          `策略已从修订 ${current.policyRevision} 变为 ${current.currentPolicyRevision}。请按当前策略重新演练此恢复点，再审核继续。`,
          `The policy changed from revision ${current.policyRevision} to ${current.currentPolicyRevision}. Rehearse this point under the current policy before approving continuation.`,
        ) : t('备份策略已暂停，接管不会继续。恢复策略并重新演练后可再次审核。',
          'The backup policy is paused. Resume it and rehearse again before reviewing continuation.')}</p>
        {current.policyEnabled && confirm !== current.id + '/reapprove' && <Button disabled={busy}
          onClick={() => setConfirm(current.id + '/reapprove')}>{t('审核继续接管', 'Review takeover continuation')}</Button>}
        {current.policyEnabled && confirm === current.id + '/reapprove' && <div>
          <p>{t('确认使用当前策略继续原恢复点和目标卷，已封存的旧写入端仍保持封存。',
            'Continue the same recovery point and target volume under the current policy. The previous writer remains fenced.')}</p>
          <Button disabled={busy} onClick={() => void run(() => api('/recoveries/' + current.id + '/reapprove', 'POST', {
            confirm: current.id, policyRevision: current.currentPolicyRevision, phase: current.phase,
          }))}>{t('确认继续', 'Confirm continuation')}</Button>{' '}
          <Button disabled={busy} onClick={() => setConfirm('')}>{t('返回', 'Back')}</Button>
        </div>}
      </div>}
      {current?.lastError && <p role="status">{t('最近一次核验', 'Last check') + ' · ' + problem(current.lastError)}</p>}
      {error && <ErrorBanner message={problem(error)} />}
      {!current && paired.length > 1 && <Field label={t('目标数据卷', 'Target data volume')}>
        <select className="input" value={selectedVolume} disabled={busy || cleanupPending}
          onChange={(event) => setVolume(event.target.value)}>
          <option value="">{t('选择已验证的数据卷', 'Select a verified data volume')}</option>
          {paired.map((target) => <option key={target.volumeId} value={target.volumeId}>{target.volumeId}</option>)}
        </select>
      </Field>}
      {!current && paired.length > 0 && (
        <Button
          disabled={busy || point.gapCount !== 0 || !selectedVolume || cleanupPending}
          onClick={() =>
            void run(() =>
              api('/recoveries', 'POST', {
                requestId: crypto.randomUUID(),
                policyId: policy.policyId,
                pointId: point.id,
                targetNode: policy.targetNodeId,
                targetVolume: selectedVolume,
              }),
            )
          }
        >
          {t('准备替换电脑', 'Prepare replacement')}
        </Button>
      )}
      {!current && options && !paired.length && <p role="status">{t(
        '目标电脑尚无通过检查的数据卷，请先在该电脑配置并验证内容存储。',
        'No verified data volume is available on the target. Configure and verify its content storage first.',
      )}</p>}
      {current?.targetActivatedAt && <div>
        <p>{t('项目已在新电脑运行。原策略不会自动改为保护新源，请另建策略并核对首个恢复点。',
          'The project is running on its replacement. Create a policy for the new source and verify its first recovery point.')}</p>
        <Button disabled={busy} onClick={onReprotect}>{t('为新电脑配置保护', 'Protect the replacement')}</Button>
      </div>}
      {step && confirm !== current!.id + '/' + step && (
        <Button disabled={busy} onClick={() => setConfirm(current!.id + '/' + step)}>
          {step === 'approve-retirement' ? t('审核原机退出', 'Review source retirement') : t('审核切换', 'Review switch')}
        </Button>
      )}
      {step && confirm === current!.id + '/' + step && (
        <div>
          <p>{help}</p>
          <Button disabled={busy} onClick={() => void run(() => Promise.resolve(operate(step)))}>
            {t('确认', 'Confirm')}
          </Button>{' '}
          <Button disabled={busy} onClick={() => setConfirm('')}>
            {t('返回', 'Back')}
          </Button>
        </div>
      )}
      {current && ['prepared', 'target-ready', 'retire-approved'].includes(current.phase) && (
        <Button disabled={busy} onClick={() => void run(() => Promise.resolve(operate('cancel')))}>
          {t('取消接管', 'Cancel takeover')}
        </Button>
      )}
      <Button disabled={busy} onClick={() => void run(() => Promise.resolve())}>
        {t('刷新接管状态', 'Refresh takeover status')}
      </Button>
    </div>
  )
}
