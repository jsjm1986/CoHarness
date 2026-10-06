import { ArrowLeft, ExternalLink, Pencil, Settings2, Sparkles, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  controlProjectInstance,
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
import { adminLanguage, translateCopy } from '../language.ts'
import { formatCostInput, parseCostInput } from '../money.ts'
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
import { zh as copyZh, en as copyEn, type ProjectDetailCopyKey } from './project-detail.copy.ts'

type MatrixMode = GrantMode | 'none'
type ProjectQuotaSource = 'inherit' | 'independent'
type ProjectLimitMode = 'unlimited' | 'custom'

export function ProjectDetailPage() {
  const { id } = useParams()
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  const projectId = Number(id)
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return (
      <div className="page projectDetailPage">
        <Link className="breadcrumb" to="/projects"><ArrowLeft aria-hidden="true" />{t('backToProjects')}</Link>
        <PageHeader title={t('pageTitle')} />
        <ErrorBanner message={t('invalidProjectId')} />
      </div>
    )
  }
  return <ProjectDetail key={id} projectId={projectId} />
}

function ProjectDetail({ projectId }: { projectId: number }) {
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameError, setRenameError] = useState('')
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
  const [runtimeAction, setRuntimeAction] = useState<'start' | 'stop' | 'restart' | null>(null)
  const [runtimeError, setRuntimeError] = useState('')
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])

  const reload = useCallback(async (showLoading = false) => {
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
  }, [projectId, t])

  useEffect(() => { void reload(true) }, [reload])

  const monthRef = useRef('')
  const usageGeneration = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const reloadUsage = useCallback(async (showLoading = false) => {
    const requestMonth = monthRef.current
    const generation = ++usageGeneration.current
    if (showLoading) {
      setUsageLoading(true)
      setContributors(null)
    }
    try {
      const [nextUsage, nextContributors] = await Promise.all([
        getProjectUsage(projectId, requestMonth || undefined),
        listUsageContributors(projectId, requestMonth || undefined),
      ])
      if (!alive.current || usageGeneration.current !== generation) return
      setUsage(nextUsage)
      setContributors(nextContributors)
      if (requestMonth === '') setMonth(current => current === '' ? nextUsage.month : current)
      setUsageError('')
    } catch (cause) {
      if (alive.current && usageGeneration.current === generation) setUsageError(messageFrom(cause))
    } finally {
      // The latest read always settles the spinner; a stale read touches nothing.
      if (alive.current && usageGeneration.current === generation) setUsageLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    monthRef.current = month
    void reloadUsage(true)
    return () => { usageGeneration.current += 1 }
  }, [month, reloadUsage])

  const reloadModelAccess = useCallback(async (showLoading = false) => {
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
  }, [projectId, t])

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
      if (!alive.current) return
      await reload()
    } catch (cause) {
      if (alive.current) setError(messageFrom(cause))
    } finally {
      if (alive.current) setPending('')
    }
  }

  async function confirmRemove() {
    if (removeTarget === null) return
    setPending(`member:${removeTarget.id}`)
    try {
      await removeMember(projectId, removeTarget.id)
      if (!alive.current) return
      setRemoveTarget(null)
      await reload()
    } catch (cause) {
      if (alive.current) setError(messageFrom(cause))
    } finally {
      if (alive.current) setPending('')
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
      if (!alive.current) return
      await reloadModelAccess()
    } catch (cause) {
      if (alive.current) setModelsError(messageFrom(cause))
    } finally {
      if (alive.current) setModelPending('')
    }
  }

  async function changeAllModelAssignments(assigned: boolean) {
    setModelPending('all')
    try {
      await setAllProjectModelAccess(projectId, assigned ? true : null)
      if (!alive.current) return
      await reloadModelAccess()
    } catch (cause) {
      if (alive.current) setModelsError(messageFrom(cause))
    } finally {
      if (alive.current) setModelPending('')
    }
  }

  async function onRename(event: FormEvent) {
    event.preventDefault()
    setPending('rename')
    setRenameError('')
    try {
      await renameProject(projectId, projectName)
      if (!alive.current) return
      setRenameOpen(false)
      await reload()
    } catch (cause) {
      if (alive.current) setRenameError(messageFrom(cause))
    } finally {
      if (alive.current) setPending('')
    }
  }

  async function onDelete() {
    setPending('delete')
    try {
      await deleteProject(projectId)
      // A stale instance's delete cannot navigate away from a remounted detail.
      if (!alive.current) return
      navigate('/projects')
    } catch (cause) {
      if (alive.current) {
        setError(messageFrom(cause))
        setPending('')
      }
    }
  }

  function openQuotaDialog() {
    const quota = project?.quota
    const storedTokens = quota?.tokenLimit ?? null
    const storedCost = quota?.companyCostMicrosLimit ?? null
    setQuotaSource(quota?.source ?? 'independent')
    setTokenMode(storedTokens === null ? 'unlimited' : 'custom')
    setCostMode(storedCost === null ? 'unlimited' : 'custom')
    setTokenLimit(storedTokens === null ? '' : String(storedTokens))
    setCostLimit(storedCost === null ? '' : formatCostInput(storedCost))
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
        if (tokenMode === 'custom' && (tokenLimit.trim() === '' || !Number.isSafeInteger(parsedToken) || parsedToken < 0)) {
          throw new Error(t('quotaTokenInvalid'))
        }
        let costMicros = 0
        if (costMode === 'custom') {
          try {
            costMicros = parseCostInput(costLimit)
          } catch {
            throw new Error(t('quotaCostInvalid'))
          }
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
      if (!alive.current) return
      setQuotaOpen(false)
      await Promise.all([reload(), reloadUsage()])
    } catch (cause) {
      if (alive.current) setQuotaError(messageFrom(cause))
    } finally {
      if (alive.current) setQuotaSaving(false)
    }
  }

  return (
    <div className="page projectDetailPage">
      <Link className="breadcrumb" to="/projects"><ArrowLeft aria-hidden="true" />{t('backToProjects')}</Link>
      <PageHeader
        title={project?.name ?? t('pageTitle')}
        description={project?.path}
        meta={project === null ? undefined : t('membersCount', { count: String(project.memberCount) })}
        actions={project === null ? undefined : <Button icon={Pencil} onClick={() => { setRenameError(''); setProjectName(project.name); setRenameOpen(true) }}>{t('rename')}</Button>}
      />
      <ErrorBanner message={error} />
      {loading ? <Section><LoadingState label={t('loadingProject')} /></Section> : project === null ? (
        <Section><EmptyState title={t('loadFailedTitle')} detail={t('loadFailedDetail')} /></Section>
      ) : (
        <>
          <div className="projectMetadata" aria-label={t('metadataAria')}>
            <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? t('originUser') : t('originAdmin')}</StatusBadge>
            <span>{t('ownerValue', { name: project.owner?.displayName || project.owner?.username || t('ownerFallback') })}</span>
            <span>{t('creatorValue', { name: project.createdBy?.displayName || project.createdBy?.username || t('creatorFallback') })}</span>
          </div>
          <Section className="projectConfigurationSection" title={t('configSectionTitle')} meta={t('configSectionMeta')} actions={(
            <a className="button button-secondary" href={`/admin/projects/${String(project.id)}/settings`}>
              <ExternalLink size={15} aria-hidden="true" />{t('openProjectSettings')}
            </a>
          )}>
            <div className="projectConfigurationSummary" aria-label={t('configSummaryAria')}>
              <div>
                <span className="definitionLabel">{t('settingsLabel')}</span>
                <strong>{t('settingsValue')}</strong>
                <p>{t('settingsNote')}</p>
              </div>
              <div>
                <span className="definitionLabel">{t('themePolicyField')}</span>
                <StatusBadge tone={project.configurationSummary?.themePolicy === 'follow-user' ? 'neutral' : 'info'}>
                  {themePolicyLabel(project.configurationSummary?.themePolicy ?? project.uiThemePolicy)}
                </StatusBadge>
              </div>
              <div>
                <span className="definitionLabel">{t('sharedRuntimeLabel')}</span>
                <span>{project.configurationSummary === undefined
                  ? t('runtimeStateUnknown')
                  : `${project.configurationSummary.runtimeState} · generation ${String(project.configurationSummary.runtimeGeneration)}`}</span>
                <div className="formActions" aria-label={t('runtimeActionsAria')}>
                  {(['start', 'stop', 'restart'] as const).map(action => (
                    <Button key={action} disabled={pending !== ''} onClick={() => { setRuntimeError(''); setRuntimeAction(action) }}>
                      {action === 'start' ? t('instanceStart') : action === 'stop' ? t('instanceStop') : t('instanceRestart')}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <span className="definitionLabel">{t('providerLabel')}</span>
                <span>{project.configurationSummary?.projectModels === undefined
                  ? t('providerNone')
                  : t('providerCount', {
                    count: String(project.configurationSummary.projectModels.providerCount),
                    revision: String(project.configurationSummary.projectModels.revision),
                  })}</span>
              </div>
              <div>
                <span className="definitionLabel">{t('serverDirectoryLabel')}</span>
                <span>{t('serverDirectoryValue')}</span>
              </div>
            </div>
            <p className="sectionHint">{t('configSectionHint')}</p>
          </Section>
          <Section
            className="projectUsageSection"
            title={t('usageSectionTitle')}
            meta={usage?.month}
            actions={(
              <div className="projectUsageToolbar">
                <label className="monthPicker"><span>{t('monthLabel')}</span><input className="input" type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
                <Button icon={Settings2} onClick={openQuotaDialog}>{t('configureQuota')}</Button>
              </div>
            )}
          >
            <ErrorBanner message={usageError} />
            {usageLoading ? <LoadingState label={t('loadingUsage')} /> : usage === null ? (
              <EmptyState title={t('usageFailedTitle')} detail={t('usageFailedDetail')} />
            ) : (
              <>
                <div className="projectUsageMetrics" aria-label={t('usageSummaryAria')}>
                  <Metric label={t('metricCalls')} value={usage.calls.toLocaleString()} />
                  <Metric label={t('metricTokens')} value={formatCompact(usage.totalTokens)} />
                  <Metric label={t('metricCost')} value={formatMoney(usage.companyCostMicros, 2)} />
                  <Metric label={t('metricMetering')} value={usage.missingUsageCalls === 0 ? t('meteringComplete') : t('meteringMissing', { count: String(usage.missingUsageCalls) })} tone={usage.missingUsageCalls > 0 ? 'warning' : undefined} />
                </div>
                <div className="projectUsageDetails">
                  <div className="projectUsagePanel">
                    <h3>{t('meteringDetail')}</h3>
                    <dl className="definitionGrid projectUsageDefinitions">
                      <Definition label={t('inputTokensLabel')}>{usage.inputTokens.toLocaleString()}</Definition>
                      <Definition label={t('outputTokensLabel')}>{usage.outputTokens.toLocaleString()}</Definition>
                      <Definition label={t('cacheReadLabel')}>{usage.cacheReadTokens.toLocaleString()}</Definition>
                      <Definition label={t('cacheWriteLabel')}>{usage.cacheWriteTokens.toLocaleString()}</Definition>
                      <Definition label={t('estimatedCostLabel')}>{formatMoney(usage.estimatedCostMicros)}</Definition>
                      <Definition label={t('missingCallsLabel')}>{t('missingCallsValue', { count: usage.missingUsageCalls.toLocaleString() })}</Definition>
                      <Definition label={t('priceLabel')}><PricingState pricing={usage.pricing} /></Definition>
                    </dl>
                  </div>
                  <div className="projectUsagePanel projectQuotaPanel" aria-label={t('effectiveQuotaTitle')}>
                    <div className="projectUsagePanelHeading"><h3>{t('effectiveQuotaTitle')}</h3><span>{t('effectiveQuotaNote')}</span></div>
                    <QuotaSummary summary={usage} />
                    <p className="quotaEffectiveNote">{quotaSourceLabel(project.quota)}</p>
                  </div>
                  <div className="projectUsagePanel projectConfigPanel" aria-label={t('projectConfigTitle')}>
                    <h3>{t('projectConfigTitle')}</h3>
                    <dl className="definitionGrid projectConfigDefinitions">
                      <Definition label={t('quotaSourceField')}>{quotaSourceLabel(project.quota)}</Definition>
                      <Definition label={t('tokenQuotaLabel')}>{formatQuotaTokens(project.quota?.tokenLimit)}</Definition>
                      <Definition label={t('costQuotaLabel')}>{formatQuotaCost(project.quota?.companyCostMicrosLimit)}</Definition>
                      <Definition label={t('pathLabel')}>{project.path}</Definition>
                      <Definition label={t('originLabel')}>{project.origin === 'user' ? t('originUser') : t('originAdmin')}</Definition>
                      <Definition label={t('ownerLabel')}>{project.owner?.displayName || project.owner?.username || t('ownerFallback')}</Definition>
                      <Definition label={t('creatorLabel')}>{project.createdBy?.displayName || project.createdBy?.username || t('creatorFallback')}</Definition>
                      <Definition label={t('memberLabel')}>{t('memberCountValue', { count: String(project.memberCount) })}</Definition>
                      <Definition label={t('modelDefaultLabel')}>
                        {projectDefaultAllowed ? t('modelDefaultAll') : t('modelDefaultExplicit')}
                      </Definition>
                      <Definition label={t('modelAccessLabel')}>
                        <div className="projectConfigModels">
                          <span>{`${assignedModelCount} / ${assignableModels.length}`}</span>
                          {assignedModels.length === 0 ? <span>{t('modelNotGranted')}</span> : assignedModels.map(model => (
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
          <Section className="responsiveSection" title={t('contributorsTitle')} meta={contributors === null ? undefined : t('contributorsMeta', { count: String(contributors.rows.length) })}>
            {contributors === null ? <LoadingState label={t('loadingContributors')} /> : (
              <>
                <p className="sectionHint">{t('contributorsHint', { tokens: contributors.unattributed.totalTokens.toLocaleString() })}</p>
                {contributors.rows.length === 0 ? <EmptyState title={t('contributorsEmptyTitle')} detail={t('contributorsEmptyDetail')} /> : (
                  <div className="tableWrap">
                    <table className="dataTable usageTable">
                      <thead><tr><th>{t('memberLabel')}</th><th>{t('callsColumn')}</th><th>Token</th><th>{t('projectsColumn')}</th><th>{t('priceLabel')}</th></tr></thead>
                      <tbody>{contributors.rows.map(row => (
                        <tr key={row.userId}>
                          <td>{row.username}{row.archived ? t('archivedSuffix') : ''}</td>
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
            title={t('modelAccessTitle')}
            meta={t('modelAccessMeta', {
              assigned: String(assignedModelCount),
              total: String(assignableModels.length),
              mode: projectDefaultAllowed ? t('modelModeAuto') : t('modelModeManual'),
            })}
            actions={assignableModels.length === 0 && !hasProjectOverrides ? undefined : (
              <div className="projectModelAccessToolbar">
                <Button
                  disabled={modelPending !== '' || assignableModels.length === 0 || assignedModelCount === assignableModels.length}
                  onClick={() => { void changeAllModelAssignments(true) }}
                >
                  {t('enableAll')}
                </Button>
                <Button
                  disabled={modelPending !== '' || (!projectDefaultAllowed && assignedModelCount === 0 && !hasProjectOverrides)}
                  onClick={() => { void changeAllModelAssignments(false) }}
                >
                  {t('disableAll')}
                </Button>
              </div>
            )}
          >
            <ErrorBanner message={modelsError} />
            {modelsLoading ? <LoadingState label={t('loadingModels')} /> : assignableModels.length === 0 ? (
              <EmptyState icon={Sparkles} title={t('modelsEmptyTitle')} detail={t('modelsEmptyDetail')} />
            ) : (
              <>
                <div className="tableWrap desktopOnly">
                  <table className="dataTable projectModelAccessTable" aria-label={t('modelAccessTitle')}>
                    <thead><tr><th>{t('modelColumn')}</th><th>{t('statusColumn')}</th><th>{t('projectAccessColumn')}</th></tr></thead>
                    <tbody>{assignableModels.map(model => {
                      const key = modelKey(model)
                      const assignedToProject = modelAssignments.has(key)
                      const providerEnabled = modelProviders.find(provider => provider.provider === model.provider)?.status === 'enabled'
                      return (
                        <tr key={key}>
                          <td><ProjectModelIdentity model={model} /></td>
                          <td><StatusBadge tone={providerEnabled && model.enabled ? 'success' : 'warning'}>{providerEnabled && model.enabled ? t('modelAvailable') : t('modelUnavailable')}</StatusBadge></td>
                          <td><Switch label={assignedToProject ? t('modelGranted') : t('modelNotGranted')} checked={assignedToProject} disabled={modelPending !== ''} onChange={value => { void changeModelAssignment(model, value) }} /></td>
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
                          <StatusBadge tone={providerEnabled && model.enabled ? 'success' : 'warning'}>{providerEnabled && model.enabled ? t('modelAvailable') : t('modelUnavailable')}</StatusBadge>
                        </div>
                        <div className="mobileItemBody">
                          <Switch label={assignedToProject ? t('modelGrantedToProject') : t('modelNotGrantedToProject')} checked={assignedToProject} disabled={modelPending !== ''} onChange={value => { void changeModelAssignment(model, value) }} />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </Section>
          <Section className="responsiveSection" title={t('membersTitle')} meta={t('membersMeta', { count: String(users.length) })}>
            {users.length === 0 ? (
              <EmptyState icon={Users} title={t('membersEmptyTitle')} detail={t('membersEmptyDetail')} />
            ) : (
              <>
                <div className="tableWrap desktopOnly">
                  <table className="dataTable permissionTable">
                    <thead><tr><th>{t('userColumn')}</th><th>{t('accountColumn')}</th><th>{t('directoryAccessLabel')}</th></tr></thead>
                    <tbody>
                      {users.map(user => {
                        const mode: MatrixMode = assigned.get(user.id) ?? 'none'
                        return (
                          <tr key={user.id}>
                            <td><MemberIdentity user={user} /></td>
                            <td><StatusBadge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? t('userActive') : t('userDisabled')}</StatusBadge></td>
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
                          <StatusBadge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? t('userActive') : t('userDisabled')}</StatusBadge>
                        </div>
                        <div className="mobileItemBody">
                          <span className="fieldLabel">{t('directoryAccessLabel')}</span>
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
            <div><strong>{t('deleteProject')}</strong><p>{t('deleteHint')}</p></div>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>{t('deleteProject')}</Button>
          </div>
        </>
      )}

      <Dialog
        open={quotaOpen}
        title={t('quotaDialogTitle')}
        description={t('quotaDialogDescription')}
        onClose={() => { if (!quotaSaving) setQuotaOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={quotaSaving} onClick={() => setQuotaOpen(false)}>{t('cancel')}</Button>
            <Button type="submit" form="project-quota-form" variant="primary" loading={quotaSaving}>{t('saveQuota')}</Button>
          </>
        )}
      >
        <form id="project-quota-form" onSubmit={event => void saveQuota(event)}>
          <ErrorBanner message={quotaError} />
          <fieldset className="projectQuotaSource">
            <legend>{t('quotaSourceField')}</legend>
            <div className="quotaSourceOptions">
              <label className="quotaSourceOption" data-selected={quotaSource === 'inherit'}>
                <input type="radio" name="project-quota-source" checked={quotaSource === 'inherit'} onChange={() => setQuotaSource('inherit')} />
                <span><strong>{t('quotaInherit')}</strong><small>{t('quotaInheritHint')}</small></span>
              </label>
              <label className="quotaSourceOption" data-selected={quotaSource === 'independent'}>
                <input type="radio" name="project-quota-source" checked={quotaSource === 'independent'} onChange={() => setQuotaSource('independent')} />
                <span><strong>{t('quotaIndependent')}</strong><small>{t('quotaIndependentHint')}</small></span>
              </label>
            </div>
          </fieldset>
          {quotaSource === 'independent' ? (
            <div className="quotaEditorGrid projectQuotaEditors">
              <ProjectQuotaEditor label={t('tokenQuotaLabel')} mode={tokenMode} value={tokenLimit} inputLabel={t('monthlyTokensLabel')} inputMode="numeric" onMode={setTokenMode} onValue={setTokenLimit} />
              <ProjectQuotaEditor label={t('companyCostQuotaLabel')} mode={costMode} value={costLimit} inputLabel={t('monthlyCostLabel')} inputMode="decimal" onMode={setCostMode} onValue={setCostLimit} />
            </div>
          ) : (
            <div className="quotaModeNote projectQuotaModeNote">
              {t('quotaInheritNote')}
            </div>
          )}
        </form>
      </Dialog>

      <Dialog
        open={renameOpen}
        title={t('renameDialogTitle')}
        description={t('renameDialogDescription')}
        onClose={() => { if (pending !== 'rename') setRenameOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={pending === 'rename'} onClick={() => setRenameOpen(false)}>{t('cancel')}</Button>
            <Button type="submit" form="rename-project-form" variant="primary" loading={pending === 'rename'}>{t('saveName')}</Button>
          </>
        )}
      >
        <form id="rename-project-form" onSubmit={event => void onRename(event)}>
          <ErrorBanner message={renameError} />
          <Field label={t('projectNameLabel')}><input className="input" required autoFocus value={projectName} onChange={event => setProjectName(event.target.value)} /></Field>
        </form>
      </Dialog>

      <Dialog
        open={runtimeAction !== null}
        title={runtimeAction === 'start' ? t('runtimeStartTitle') : runtimeAction === 'stop' ? t('runtimeStopTitle') : t('runtimeRestartTitle')}
        description={runtimeAction === 'start' ? t('runtimeStartDescription')
          : t('runtimeStopDescription', { name: project?.name ?? '' })}
        onClose={() => { if (pending !== 'runtime') setRuntimeAction(null) }}
        footer={<>
          <Button disabled={pending === 'runtime'} onClick={() => { setRuntimeAction(null) }}>{t('cancel')}</Button>
          <Button variant="primary" loading={pending === 'runtime'} onClick={() => {
            const action = runtimeAction
            if (action === null) return
            setPending('runtime'); setRuntimeError('')
            void controlProjectInstance(projectId, action).then(async () => { setRuntimeAction(null); await reload() })
              .catch((cause: unknown) => { setRuntimeError(messageFrom(cause)) })
              .finally(() => { setPending('') })
          }}>{t('confirmExecute')}</Button>
        </>}
      ><ErrorBanner message={runtimeError} /></Dialog>

      <ConfirmDialog
        open={removeTarget !== null}
        title={t('removeMemberTitle')}
        description={t('removeMemberDescription', { name: removeTarget?.username ?? '' })}
        confirmLabel={t('confirmRemove')}
        pending={removeTarget !== null && pending === `member:${removeTarget.id}`}
        onClose={() => { if (!pending.startsWith('member:')) setRemoveTarget(null) }}
        onConfirm={() => void confirmRemove()}
      />
      <ConfirmDialog
        open={deleteOpen}
        title={t('deleteProject')}
        description={t('deleteDialogDescription', { name: project?.name ?? '' })}
        confirmLabel={t('confirmDelete')}
        pending={pending === 'delete'}
        onClose={() => { if (pending !== 'delete') setDeleteOpen(false) }}
        onConfirm={() => void onDelete()}
      />
    </div>
  )
}

function MemberIdentity({ user }: { user: AdminUser }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{(user.displayName || user.username).slice(0, 1)}</span>
      <span className="identityText"><strong>{user.displayName || user.username}</strong><span>@{user.username} · {user.role === 'admin' ? t('roleAdmin') : t('roleUser')}</span></span>
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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  const options: Array<[MatrixMode, string]> = [
    ['none', t('permissionNone')],
    ['ro', t('permissionRo')],
    ['rw', t('permissionRw')],
  ]
  return (
    <div className="segmented permissionControl" aria-label={t('permissionAria', { name: user.username })}>
      {options.map(([value, label]) => (
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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label={t('quotaModeLabel')}>
        <select className="select" value={mode} onChange={event => onMode(event.target.value as ProjectLimitMode)}>
          <option value="unlimited">{t('quotaUnlimited')}</option>
          <option value="custom">{t('quotaCustom')}</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} value={value} onChange={event => onValue(event.target.value)} />
        </Field>
      ) : <div className="quotaModeNote">{t('quotaNoCap')}</div>}
    </fieldset>
  )
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

/** The translate seat for module-level helpers that cannot memoize inside a component. */
function translate(key: ProjectDetailCopyKey, parameters?: Record<string, string>): string {
  return translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })(key, parameters)
}

function quotaSourceLabel(quota: ProjectQuota | undefined): string {
  return quota?.source === 'independent' ? translate('quotaIndependent') : translate('quotaInherit')
}

function formatQuotaTokens(limit: number | null | undefined): string {
  return limit === null || limit === undefined ? translate('quotaNoLimit') : limit.toLocaleString('zh-CN')
}

function formatQuotaCost(limit: number | null | undefined): string {
  return limit === null || limit === undefined ? translate('quotaNoLimit') : formatMoney(limit, 2)
}

function themePolicyLabel(policy: 'follow-user' | 'light' | 'dark' | undefined): string {
  if (policy === 'light') return translate('themeLight')
  if (policy === 'dark') return translate('themeDark')
  return translate('themeFollowUser')
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
