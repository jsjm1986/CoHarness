import { ArrowLeft, Pencil, Settings2, Sparkles, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  deleteProject,
  getProjectModelAccess,
  getProject,
  listUsageContributors,
  getProjectUsage,
  listModelProviders,
  listModels,
  listUsers,
  removeMember,
  renameProject,
  setMember,
  setAllProjectModelAccess,
  setProjectModelAccess,
  setQuota,
  type AdminUser,
  type GrantMode,
  type ModelGovernanceRow,
  type ModelProviderRow,
  type ProjectDetail,
  type ProjectQuota,
  type UsageSummary,
  type UsageContributorReport,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
  Switch,
} from '../components/ui.tsx'
import { formatCompact, formatMoney, Metric, PricingState, QuotaSummary } from '../components/usage.tsx'

type MatrixMode = GrantMode | 'none'
type ProjectQuotaSource = 'inherit' | 'independent'
type ProjectLimitMode = 'unlimited' | 'custom'

export function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const projectId = Number(id)
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [removeTarget, setRemoveTarget] = useState<AdminUser | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [month, setMonth] = useState('')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [contributors, setContributors] = useState<UsageContributorReport | null>(null)
  const [usageLoading, setUsageLoading] = useState(true)
  const [usageError, setUsageError] = useState('')
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [quotaSaving, setQuotaSaving] = useState(false)
  const [quotaError, setQuotaError] = useState('')
  const [quotaSource, setQuotaSource] = useState<ProjectQuotaSource>('independent')
  const [tokenMode, setTokenMode] = useState<ProjectLimitMode>('unlimited')
  const [costMode, setCostMode] = useState<ProjectLimitMode>('unlimited')
  const [tokenLimit, setTokenLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')
  const [models, setModels] = useState<ModelGovernanceRow[]>([])
  const [modelProviders, setModelProviders] = useState<ModelProviderRow[]>([])
  const [modelAssignments, setModelAssignments] = useState(new Set<string>())
  const [projectDefaultAllowed, setProjectDefaultAllowed] = useState(false)
  const [hasProjectOverrides, setHasProjectOverrides] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState('')
  const [modelPending, setModelPending] = useState('')

  const reload = useCallback(async (showLoading = false) => {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      setError('项目 ID 无效')
      setLoading(false)
      return
    }
    if (showLoading) setLoading(true)
    try {
      const [nextProject, nextUsers] = await Promise.all([getProject(projectId), listUsers()])
      setProject(nextProject)
      setProjectName(nextProject.name)
      setUsers(nextUsers)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void reload(true) }, [reload])

  const reloadUsage = useCallback(async (showLoading = false) => {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      setUsageError('项目 ID 无效')
      setUsageLoading(false)
      return
    }
    if (showLoading) {
      setUsageLoading(true)
      setContributors(null)
    }
    try {
      const [nextUsage, nextContributors] = await Promise.all([
        getProjectUsage(projectId, month || undefined),
        listUsageContributors(projectId, month || undefined),
      ])
      setUsage(nextUsage)
      setContributors(nextContributors)
      if (month === '') setMonth(current => current === '' ? nextUsage.month : current)
      setUsageError('')
    } catch (cause) {
      setUsageError(messageFrom(cause))
    } finally {
      if (showLoading) setUsageLoading(false)
    }
  }, [month, projectId])

  useEffect(() => { void reloadUsage(true) }, [reloadUsage])

  const reloadModelAccess = useCallback(async (showLoading = false) => {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      setModelsError('项目 ID 无效')
      setModelsLoading(false)
      return
    }
    if (showLoading) setModelsLoading(true)
    try {
      const [nextModels, nextProviders, access] = await Promise.all([
        listModels(),
        listModelProviders(),
        getProjectModelAccess(projectId),
      ])
      setModels(nextModels)
      setModelProviders(nextProviders)
      setProjectDefaultAllowed(access.projectDefaultAllowed)
      setHasProjectOverrides(access.overrides.length > 0)
      setModelAssignments(new Set(access.effective.models.filter(row => row.allowed).map(modelKey)))
      setModelsError('')
    } catch (cause) {
      setModelsError(messageFrom(cause))
    } finally {
      if (showLoading) setModelsLoading(false)
    }
  }, [projectId])

  useEffect(() => { void reloadModelAccess(true) }, [reloadModelAccess])

  const assigned = useMemo(() => new Map((project?.members ?? []).map(member => [member.userId, member.mode])), [project])
  const assignableModels = useMemo(() => {
    const providers = new Map(modelProviders.map(provider => [provider.provider, provider]))
    return models.filter(model => {
      const provider = providers.get(model.provider)
      return provider?.source === 'managed' && provider.status !== 'archived'
    })
  }, [modelProviders, models])
  const assignableModelKeys = useMemo(() => new Set(assignableModels.map(modelKey)), [assignableModels])
  const assignedModelCount = useMemo(() => {
    let count = 0
    for (const key of modelAssignments) if (assignableModelKeys.has(key)) count += 1
    return count
  }, [assignableModelKeys, modelAssignments])
  const assignedModels = useMemo(
    () => assignableModels.filter(model => modelAssignments.has(modelKey(model))),
    [assignableModels, modelAssignments],
  )

  async function applyMode(userId: number, mode: GrantMode) {
    setPending(`member:${userId}`)
    try {
      await setMember(projectId, userId, mode)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPending('')
    }
  }

  async function confirmRemove() {
    if (removeTarget === null) return
    setPending(`member:${removeTarget.id}`)
    try {
      await removeMember(projectId, removeTarget.id)
      setRemoveTarget(null)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPending('')
    }
  }

  async function changeModelAssignment(model: ModelGovernanceRow, assigned: boolean) {
    const key = modelKey(model)
    setModelPending(key)
    try {
      await setProjectModelAccess(
        projectId,
        model.provider,
        model.model,
        assigned ? true : projectDefaultAllowed ? false : null,
      )
      await reloadModelAccess()
    } catch (cause) {
      setModelsError(messageFrom(cause))
    } finally {
      setModelPending('')
    }
  }

  async function changeAllModelAssignments(assigned: boolean) {
    setModelPending('all')
    try {
      await setAllProjectModelAccess(projectId, assigned ? true : null)
      await reloadModelAccess()
    } catch (cause) {
      setModelsError(messageFrom(cause))
    } finally {
      setModelPending('')
    }
  }

  async function onRename(event: FormEvent) {
    event.preventDefault()
    setPending('rename')
    try {
      await renameProject(projectId, projectName)
      setRenameOpen(false)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPending('')
    }
  }

  async function onDelete() {
    setPending('delete')
    try {
      await deleteProject(projectId)
      navigate('/projects')
    } catch (cause) {
      setError(messageFrom(cause))
      setPending('')
    }
  }

  function openQuotaDialog() {
    setQuotaSource('independent')
    setTokenMode('unlimited')
    setCostMode('unlimited')
    setTokenLimit('')
    setCostLimit('')
    setQuotaError('')
    setQuotaOpen(true)
  }

  async function saveQuota(event: FormEvent) {
    event.preventDefault()
    setQuotaSaving(true)
    setQuotaError('')
    try {
      let nextTokenLimit: number | null | 'inherit' = 'inherit'
      let nextCostLimit: number | null | 'inherit' = 'inherit'
      if (quotaSource === 'independent') {
        const parsedToken = Number(tokenLimit)
        const parsedCost = Number(costLimit)
        if (tokenMode === 'custom' && (!Number.isSafeInteger(parsedToken) || parsedToken < 0)) {
          throw new Error('Token 额度必须是非负整数')
        }
        const costMicros = Math.round(parsedCost * 1_000_000)
        if (costMode === 'custom' && (!Number.isFinite(parsedCost) || parsedCost < 0 || !Number.isSafeInteger(costMicros))) {
          throw new Error('成本额度必须是有效的非负数')
        }
        nextTokenLimit = tokenMode === 'unlimited' ? null : parsedToken
        nextCostLimit = costMode === 'unlimited' ? null : costMicros
      }
      await setQuota({
        subjectType: 'project',
        subjectId: String(projectId),
        tokenLimit: nextTokenLimit,
        companyCostMicrosLimit: nextCostLimit,
      })
      setQuotaOpen(false)
      await Promise.all([reload(), reloadUsage()])
    } catch (cause) {
      setQuotaError(messageFrom(cause))
    } finally {
      setQuotaSaving(false)
    }
  }

  return (
    <div className="page projectDetailPage">
      <Link className="breadcrumb" to="/projects"><ArrowLeft aria-hidden="true" />返回项目</Link>
      <PageHeader
        title={project?.name ?? '项目详情'}
        description={project?.path}
        meta={project === null ? undefined : `${project.memberCount} 位成员`}
        actions={project === null ? undefined : <Button icon={Pencil} onClick={() => setRenameOpen(true)}>重命名</Button>}
      />
      <ErrorBanner message={error} />
      {loading ? <Section><LoadingState label="正在加载项目" /></Section> : project === null ? (
        <Section><EmptyState title="无法加载项目" detail="请返回项目列表后重试。" /></Section>
      ) : (
        <>
          <div className="projectMetadata" aria-label="项目来源信息">
            <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? '用户发起' : '管理员发起'}</StatusBadge>
            <span>所有者：{project.owner?.displayName || project.owner?.username || '组织管理'}</span>
            <span>创建者：{project.createdBy?.displayName || project.createdBy?.username || '未知'}</span>
          </div>
          <Section
            className="projectUsageSection"
            title="项目用量"
            meta={usage?.month}
            actions={(
              <div className="projectUsageToolbar">
                <label className="monthPicker"><span>月份</span><input className="input" type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
                <Button icon={Settings2} onClick={openQuotaDialog}>配置额度</Button>
              </div>
            )}
          >
            <ErrorBanner message={usageError} />
            {usageLoading ? <LoadingState label="正在加载项目用量" /> : usage === null ? (
              <EmptyState title="无法加载项目用量" detail="请稍后重试或选择其他月份。" />
            ) : (
              <>
                <div className="projectUsageMetrics" aria-label="项目用量汇总">
                  <Metric label="调用次数" value={usage.calls.toLocaleString()} />
                  <Metric label="Token 总量" value={formatCompact(usage.totalTokens)} />
                  <Metric label="公司成本" value={formatMoney(usage.companyCostMicros, 2)} />
                  <Metric label="计量状态" value={usage.missingUsageCalls === 0 ? '完整' : `缺失 ${usage.missingUsageCalls} 次`} tone={usage.missingUsageCalls > 0 ? 'warning' : undefined} />
                </div>
                <div className="projectUsageDetails">
                  <div className="projectUsagePanel">
                    <h3>计量明细</h3>
                    <dl className="definitionGrid projectUsageDefinitions">
                      <Definition label="输入 Token">{usage.inputTokens.toLocaleString()}</Definition>
                      <Definition label="输出 Token">{usage.outputTokens.toLocaleString()}</Definition>
                      <Definition label="缓存读取">{usage.cacheReadTokens.toLocaleString()}</Definition>
                      <Definition label="缓存写入">{usage.cacheWriteTokens.toLocaleString()}</Definition>
                      <Definition label="估算成本">{formatMoney(usage.estimatedCostMicros)}</Definition>
                      <Definition label="缺失计量">{usage.missingUsageCalls.toLocaleString()} 次</Definition>
                      <Definition label="价格"><PricingState pricing={usage.pricing} /></Definition>
                    </dl>
                  </div>
                  <div className="projectUsagePanel projectQuotaPanel" aria-label="生效额度">
                    <div className="projectUsagePanelHeading"><h3>生效额度</h3><span>告警不阻断调用</span></div>
                    <QuotaSummary summary={usage} />
                    <p className="quotaEffectiveNote">{quotaSourceLabel(project.quota)}</p>
                  </div>
                  <div className="projectUsagePanel projectConfigPanel" aria-label="项目配置">
                    <h3>项目配置</h3>
                    <dl className="definitionGrid projectConfigDefinitions">
                      <Definition label="额度来源">{quotaSourceLabel(project.quota)}</Definition>
                      <Definition label="Token 额度">{formatQuotaTokens(project.quota?.tokenLimit)}</Definition>
                      <Definition label="成本额度">{formatQuotaCost(project.quota?.companyCostMicrosLimit)}</Definition>
                      <Definition label="路径">{project.path}</Definition>
                      <Definition label="来源">{project.origin === 'user' ? '用户发起' : '管理员发起'}</Definition>
                      <Definition label="所有者">{project.owner?.displayName || project.owner?.username || '组织管理'}</Definition>
                      <Definition label="创建者">{project.createdBy?.displayName || project.createdBy?.username || '未知'}</Definition>
                      <Definition label="成员">{`${project.memberCount} 位`}</Definition>
                      <Definition label="模型默认规则">
                        {projectDefaultAllowed ? '自动授权全部可用组织模型' : '仅授权项目明确选择的模型'}
                      </Definition>
                      <Definition label="模型权限">
                        <div className="projectConfigModels">
                          <span>{`${assignedModelCount} / ${assignableModels.length}`}</span>
                          {assignedModels.length === 0 ? <span>未授权</span> : assignedModels.map(model => (
                            <span className="projectConfigModel" key={modelKey(model)}>{model.displayName}</span>
                          ))}
                        </div>
                      </Definition>
                    </dl>
                  </div>
                </div>
              </>
            )}
          </Section>
          <Section className="responsiveSection" title="成员贡献" meta={contributors === null ? undefined : `${contributors.rows.length} 位已确认成员`}>
            {contributors === null ? <LoadingState label="正在加载成员贡献" /> : (
              <>
                <p className="sectionHint">贡献统计用于活动分析，不会重复计入项目账务或成员额度。历史未拆分调用：{contributors.unattributed.totalTokens.toLocaleString()} Token。</p>
                {contributors.rows.length === 0 ? <EmptyState title="暂无已确认成员贡献" detail="项目调用仍会计入项目总量；没有 participant 身份的历史调用会保留为未拆分。" /> : (
                  <div className="tableWrap">
                    <table className="dataTable usageTable">
                      <thead><tr><th>成员</th><th>调用</th><th>Token</th><th>涉及项目</th><th>价格</th></tr></thead>
                      <tbody>{contributors.rows.map(row => (
                        <tr key={row.userId}>
                          <td>{row.username}{row.archived ? '（已归档）' : ''}</td>
                          <td>{row.calls.toLocaleString()}</td>
                          <td>{row.totalTokens.toLocaleString()}</td>
                          <td>{row.projectCount.toLocaleString()}</td>
                          <td><PricingState pricing={row.pricing} /></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Section>
          <Section
            className="responsiveSection"
            title="项目模型权限"
            meta={`${assignedModelCount} / ${assignableModels.length} 个模型已授权 · ${projectDefaultAllowed ? '新增组织模型自动授权' : '按项目单独授权'} · 所有成员共享`}
            actions={assignableModels.length === 0 && !hasProjectOverrides ? undefined : (
              <div className="projectModelAccessToolbar">
                <Button
                  disabled={modelPending !== '' || assignableModels.length === 0 || assignedModelCount === assignableModels.length}
                  onClick={() => { void changeAllModelAssignments(true) }}
                >
                  全部开启
                </Button>
                <Button
                  disabled={modelPending !== '' || (!projectDefaultAllowed && assignedModelCount === 0 && !hasProjectOverrides)}
                  onClick={() => { void changeAllModelAssignments(false) }}
                >
                  全部关闭
                </Button>
              </div>
            )}
          >
            <ErrorBanner message={modelsError} />
            {modelsLoading ? <LoadingState label="正在加载项目模型权限" /> : assignableModels.length === 0 ? (
              <EmptyState icon={Sparkles} title="没有可分配的组织模型" detail="请先在模型治理中配置完整的组织 Provider 和模型。" />
            ) : (
              <>
                <div className="tableWrap desktopOnly">
                  <table className="dataTable projectModelAccessTable" aria-label="项目模型权限">
                    <thead><tr><th>模型</th><th>运行状态</th><th>项目权限</th></tr></thead>
                    <tbody>{assignableModels.map(model => {
                      const key = modelKey(model)
                      const assignedToProject = modelAssignments.has(key)
                      const providerEnabled = modelProviders.find(provider => provider.provider === model.provider)?.status === 'enabled'
                      return (
                        <tr key={key}>
                          <td><ProjectModelIdentity model={model} /></td>
                          <td><StatusBadge tone={providerEnabled && model.enabled ? 'success' : 'warning'}>{providerEnabled && model.enabled ? '可用' : '暂不可用'}</StatusBadge></td>
                          <td><Switch label={assignedToProject ? '已授权' : '未授权'} checked={assignedToProject} disabled={modelPending !== ''} onChange={value => { void changeModelAssignment(model, value) }} /></td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                </div>
                <div className="mobileList">
                  {assignableModels.map(model => {
                    const key = modelKey(model)
                    const assignedToProject = modelAssignments.has(key)
                    const providerEnabled = modelProviders.find(provider => provider.provider === model.provider)?.status === 'enabled'
                    return (
                      <article className="mobileItem" key={key}>
                        <div className="mobileItemHeader">
                          <ProjectModelIdentity model={model} />
                          <StatusBadge tone={providerEnabled && model.enabled ? 'success' : 'warning'}>{providerEnabled && model.enabled ? '可用' : '暂不可用'}</StatusBadge>
                        </div>
                        <div className="mobileItemBody">
                          <Switch label={assignedToProject ? '已授权给项目' : '未授权给项目'} checked={assignedToProject} disabled={modelPending !== ''} onChange={value => { void changeModelAssignment(model, value) }} />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </Section>
          <Section className="responsiveSection" title="成员权限" meta={`${users.length} 位可分配用户`}>
            {users.length === 0 ? (
              <EmptyState icon={Users} title="没有可分配用户" detail="先在用户页面创建账号，再配置项目权限。" />
            ) : (
              <>
                <div className="tableWrap desktopOnly">
                  <table className="dataTable permissionTable">
                    <thead><tr><th>用户</th><th>账号</th><th>目录权限</th></tr></thead>
                    <tbody>
                      {users.map(user => {
                        const mode: MatrixMode = assigned.get(user.id) ?? 'none'
                        return (
                          <tr key={user.id}>
                            <td><MemberIdentity user={user} /></td>
                            <td><StatusBadge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? '正常' : '已禁用'}</StatusBadge></td>
                            <td><PermissionControl user={user} mode={mode} pending={pending === `member:${user.id}`} onChange={value => changeMode(user, mode, value, setRemoveTarget, applyMode)} /></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mobileList">
                  {users.map(user => {
                    const mode: MatrixMode = assigned.get(user.id) ?? 'none'
                    return (
                      <article className="mobileItem" key={user.id}>
                        <div className="mobileItemHeader">
                          <MemberIdentity user={user} />
                          <StatusBadge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? '正常' : '已禁用'}</StatusBadge>
                        </div>
                        <div className="mobileItemBody">
                          <span className="fieldLabel">目录权限</span>
                          <PermissionControl user={user} mode={mode} pending={pending === `member:${user.id}`} onChange={value => changeMode(user, mode, value, setRemoveTarget, applyMode)} />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </Section>
          <div className="dangerZone">
            <div><strong>删除项目</strong><p>删除授权记录，不会删除宿主机上的项目目录或文件。</p></div>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>删除项目</Button>
          </div>
        </>
      )}

      <Dialog
        open={quotaOpen}
        title="配置项目额度"
        description="额度按自然月统计，在 80% 和 100% 产生告警，但不会阻断模型调用。"
        onClose={() => { if (!quotaSaving) setQuotaOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={quotaSaving} onClick={() => setQuotaOpen(false)}>取消</Button>
            <Button type="submit" form="project-quota-form" variant="primary" loading={quotaSaving}>保存额度</Button>
          </>
        )}
      >
        <form id="project-quota-form" onSubmit={event => void saveQuota(event)}>
          <ErrorBanner message={quotaError} />
          <fieldset className="projectQuotaSource">
            <legend>额度来源</legend>
            <div className="quotaSourceOptions">
              <label className="quotaSourceOption" data-selected={quotaSource === 'inherit'}>
                <input type="radio" name="project-quota-source" checked={quotaSource === 'inherit'} onChange={() => setQuotaSource('inherit')} />
                <span><strong>继承普通成员额度</strong><small>跟随普通用户角色的默认额度</small></span>
              </label>
              <label className="quotaSourceOption" data-selected={quotaSource === 'independent'}>
                <input type="radio" name="project-quota-source" checked={quotaSource === 'independent'} onChange={() => setQuotaSource('independent')} />
                <span><strong>项目独立额度</strong><small>为此项目单独设置 Token 和成本额度</small></span>
              </label>
            </div>
          </fieldset>
          {quotaSource === 'independent' ? (
            <div className="quotaEditorGrid projectQuotaEditors">
              <ProjectQuotaEditor label="Token 额度" mode={tokenMode} value={tokenLimit} inputLabel="每月 Token" inputMode="numeric" onMode={setTokenMode} onValue={setTokenLimit} />
              <ProjectQuotaEditor label="公司成本额度" mode={costMode} value={costLimit} inputLabel="每月人民币元" inputMode="decimal" onMode={setCostMode} onValue={setCostLimit} />
            </div>
          ) : (
            <div className="quotaModeNote projectQuotaModeNote">
              此项目将使用普通成员角色的月度额度。
            </div>
          )}
        </form>
      </Dialog>

      <Dialog
        open={renameOpen}
        title="重命名项目"
        description="项目路径和成员权限不会改变。"
        onClose={() => { if (pending !== 'rename') setRenameOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={pending === 'rename'} onClick={() => setRenameOpen(false)}>取消</Button>
            <Button type="submit" form="rename-project-form" variant="primary" loading={pending === 'rename'}>保存名称</Button>
          </>
        )}
      >
        <form id="rename-project-form" onSubmit={event => void onRename(event)}>
          <Field label="项目名称"><input className="input" required autoFocus value={projectName} onChange={event => setProjectName(event.target.value)} /></Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={removeTarget !== null}
        title="移除项目成员"
        description={`移除 ${removeTarget?.username ?? ''} 后，该用户将失去此项目目录的访问权限。`}
        confirmLabel="确认移除"
        pending={removeTarget !== null && pending === `member:${removeTarget.id}`}
        onClose={() => { if (!pending.startsWith('member:')) setRemoveTarget(null) }}
        onConfirm={() => void confirmRemove()}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除项目"
        description={`删除 ${project?.name ?? ''} 的授权记录？宿主机目录不会被删除。`}
        confirmLabel="确认删除"
        pending={pending === 'delete'}
        onClose={() => { if (pending !== 'delete') setDeleteOpen(false) }}
        onConfirm={() => void onDelete()}
      />
    </div>
  )
}

function MemberIdentity({ user }: { user: AdminUser }) {
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{(user.displayName || user.username).slice(0, 1)}</span>
      <span className="identityText"><strong>{user.displayName || user.username}</strong><span>@{user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}</span></span>
    </div>
  )
}

function ProjectModelIdentity({ model }: { model: ModelGovernanceRow }) {
  return (
    <div className="modelIdentity">
      <span className="itemIcon"><Sparkles aria-hidden="true" /></span>
      <span className="modelIdentityText"><strong>{model.displayName}</strong><span className="codeText">{model.provider}/{model.model}</span></span>
    </div>
  )
}

function PermissionControl({ user, mode, pending, onChange }: {
  user: AdminUser
  mode: MatrixMode
  pending: boolean
  onChange: (mode: MatrixMode) => void
}) {
  return (
    <div className="segmented permissionControl" aria-label={`${user.username} 目录权限`}>
      {([
        ['none', '无权限'],
        ['ro', '只读'],
        ['rw', '读写'],
      ] as const).map(([value, label]) => (
        <button key={value} type="button" aria-pressed={mode === value} disabled={pending} onClick={() => onChange(value)}>{label}</button>
      ))}
    </div>
  )
}

function ProjectQuotaEditor({ label, mode, value, inputLabel, inputMode, onMode, onValue }: {
  label: string
  mode: ProjectLimitMode
  value: string
  inputLabel: string
  inputMode: 'numeric' | 'decimal'
  onMode: (mode: ProjectLimitMode) => void
  onValue: (value: string) => void
}) {
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label="额度模式">
        <select className="select" value={mode} onChange={event => onMode(event.target.value as ProjectLimitMode)}>
          <option value="unlimited">无限制</option>
          <option value="custom">自定义</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} value={value} onChange={event => onValue(event.target.value)} />
        </Field>
      ) : <div className="quotaModeNote">不设置月度上限。</div>}
    </fieldset>
  )
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function quotaSourceLabel(quota: ProjectQuota | undefined): string {
  return quota?.source === 'independent' ? '项目独立额度' : '继承普通成员额度'
}

function formatQuotaTokens(limit: number | null | undefined): string {
  return limit === null || limit === undefined ? '不限' : limit.toLocaleString('zh-CN')
}

function formatQuotaCost(limit: number | null | undefined): string {
  return limit === null || limit === undefined ? '不限' : formatMoney(limit, 2)
}

function changeMode(
  user: AdminUser,
  current: MatrixMode,
  next: MatrixMode,
  setRemoveTarget: (user: AdminUser) => void,
  applyMode: (userId: number, mode: GrantMode) => Promise<void>,
) {
  if (current === next) return
  if (next === 'none') {
    setRemoveTarget(user)
    return
  }
  void applyMode(user.id, next)
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function modelKey(model: { provider: string; model: string }): string {
  return `${model.provider}\0${model.model}`
}
