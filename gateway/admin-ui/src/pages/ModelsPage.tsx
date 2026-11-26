import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useProtectedNavigation } from '../pending-edits.tsx'
import {
  getDigestModelSettings, getModelAccess, listModelRegistrations, listModels, listUsers, setModelAccess,
  type AdminUser, type ModelGovernanceRow, type ModelRegistrationReport,
} from '../api.ts'
import { createPageImport, PageLoadFailure, PageLoading } from '../components/async-route.tsx'
import { OrganizationModelsEditor } from '../components/OrganizationModelsEditor.tsx'
import { modelKey } from '../components/models.tsx'
import { Button, ErrorBanner, PageHeader } from '../components/ui.tsx'
import type { DigestModelRead, RegistrationFilters } from './ModelsDetails.tsx'
import { modelsPageT } from './models-page.copy.ts'

const modelDetails = createPageImport(() => import('./ModelsDetails.tsx'), 1)

type DetailsSelection = { tab: 'governance' | 'personal' }
type ModelsView = 'catalog' | DetailsSelection['tab']
type ActiveDetailsView = { selection: DetailsSelection; digestRead?: DigestModelRead } & (
  | { status: 'loading' }
  | { status: 'ready'; details: typeof import('./ModelsDetails.tsx') }
  | { status: 'error' }
)
type ActiveModelsView = { status: 'catalog' } | ActiveDetailsView

const EMPTY_REGISTRATION_FILTERS: RegistrationFilters = {
  user: '', provider: '', model: '', action: '', from: '', to: '',
}
const EMPTY_USERS: AdminUser[] = []

const REGISTRATION_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function registrationDate(value: string, endOfDay: boolean): number | undefined {
  if (value === '') return undefined
  const parts = REGISTRATION_DATE_PATTERN.exec(value)
  if (parts === null) throw new Error(modelsPageT()('dateFormatInvalid'))
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`)
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
    throw new Error(modelsPageT()('dateInvalid'))
  }
  return endOfDay ? date.getTime() + 1 : date.getTime()
}

/** @returns the model catalog and its deferred administration views. */
export function ModelsPage() {
  const t = useMemo(() => modelsPageT(), [])
  const navigation = useProtectedNavigation()
  const [activeView, setView] = useState<ActiveModelsView>({ status: 'catalog' })
  const view = activeView.status === 'catalog' ? 'catalog' : activeView.selection.tab
  const showDetails = view !== 'catalog'
  function changeView(next: ModelsView): void {
    if (next === view || !navigation.canReplace()) return
    if (next === 'catalog') {
      setView({ status: 'catalog' })
      return
    }
    const selection = { tab: next }
    const details = modelDetails.loaded
    setView(details === undefined ? { selection, status: 'loading' } : { selection, status: 'ready', details })
    function updateSelection(update: (current: ActiveDetailsView) => ActiveDetailsView): void {
      setView(current => current.status !== 'catalog' && current.selection === selection ? update(current) : current)
    }
    if (next === 'governance') {
      void getDigestModelSettings().then(
        settings => updateSelection(current => ({ ...current, digestRead: { ok: true, settings } })),
        cause => updateSelection(current => ({ ...current, digestRead: { ok: false, message: messageFrom(cause) } })),
      )
    }
    if (details !== undefined) return
    void modelDetails.load().then(
      module => {
        updateSelection(current => ({ ...current, status: 'ready', details: module }))
      },
      (cause: unknown) => {
        console.error('Admin page import failed', cause)
        updateSelection(current => ({ ...current, status: 'error' }))
      },
    )
  }
  const [models, setModels] = useState<ModelGovernanceRow[]>([])
  const [userList, setUserList] = useState<AdminUser[]>()
  const [userListError, setUserListError] = useState('')
  const [userListAttempt, retryUserList] = useState(0)
  const users = userList ?? EMPTY_USERS
  const [loading, setLoading] = useState(true)
  const [modelsError, setModelsError] = useState('')
  const [accessLoading, setAccessLoading] = useState(false)
  const [error, setError] = useState('')

  const [selectedUser, setSelectedUser] = useState('')
  const [overrides, setOverrides] = useState(new Map<string, boolean>())
  const [overridePending, setOverridePending] = useState('')
  const [registrationReport, setRegistrationReport] = useState<ModelRegistrationReport | null>(null)
  const [registrationLoading, setRegistrationLoading] = useState(false)
  const [registrationError, setRegistrationError] = useState('')
  const [registrationDraft, setRegistrationDraft] = useState<RegistrationFilters>(EMPTY_REGISTRATION_FILTERS)
  const [registrationFilters, setRegistrationFilters] = useState<RegistrationFilters>(EMPTY_REGISTRATION_FILTERS)
  const registrationRequest = useRef<AbortController | undefined>(undefined)

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setModels(await listModels())
      setModelsError('')
    } catch (cause) {
      setModelsError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void reload(true) }, [reload])

  useEffect(() => {
    if (!showDetails || userList !== undefined) return
    const controller = new AbortController()
    const { signal } = controller
    setUserListError('')
    void listUsers('organization', signal).then(nextUsers => {
      if (signal.aborted) return
      setUserList(nextUsers)
      setSelectedUser(String(nextUsers[0]?.id ?? ''))
    }, cause => {
      if (!signal.aborted) setUserListError(messageFrom(cause))
    })
    return () => { controller.abort() }
  }, [showDetails, userList, userListAttempt])

  const reloadRegistrations = useCallback(async () => {
    registrationRequest.current?.abort()
    const controller = new AbortController()
    registrationRequest.current = controller
    const { signal } = controller
    setRegistrationLoading(true)
    setRegistrationError('')
    try {
      const next = await listModelRegistrations({
        ...registrationFilters.user === '' ? {} : { userId: Number(registrationFilters.user) },
        ...registrationFilters.provider.trim() === '' ? {} : { provider: registrationFilters.provider.trim() },
        ...registrationFilters.model.trim() === '' ? {} : { model: registrationFilters.model.trim() },
        ...registrationFilters.action === '' ? {} : { action: registrationFilters.action },
        ...registrationFilters.from === '' ? {} : { from: registrationDate(registrationFilters.from, false) },
        ...registrationFilters.to === '' ? {} : { to: registrationDate(registrationFilters.to, true) },
        limit: 200,
      }, signal)
      if (!signal.aborted) setRegistrationReport(next)
    } catch (cause) {
      if (!signal.aborted) setRegistrationError(messageFrom(cause))
    } finally {
      if (!signal.aborted) {
        registrationRequest.current = undefined
        setRegistrationLoading(false)
      }
    }
  }, [registrationFilters])

  useEffect(() => {
    if (view !== 'personal') return
    void reloadRegistrations()
    return () => { registrationRequest.current?.abort() }
  }, [reloadRegistrations, view])

  useEffect(() => {
    if (view !== 'governance') return
    let active = true
    if (selectedUser === '') {
      setOverrides(new Map())
      setAccessLoading(false)
      return () => { active = false }
    }
    setAccessLoading(true)
    void getModelAccess(Number(selectedUser)).then(access => {
      if (!active) return
      setOverrides(new Map(access.overrides.map(row => [modelKey(row), row.allowed])))
      setError('')
    }).catch(cause => {
      if (active) setError(messageFrom(cause))
    }).finally(() => {
      if (active) setAccessLoading(false)
    })
    return () => { active = false }
  }, [selectedUser, view])

  const selected = useMemo(() => users.find(user => String(user.id) === selectedUser), [selectedUser, users])
  const modelSettingsChanged = useCallback(() => { void reload() }, [reload])

  function updateRegistrationFilters(filters: RegistrationFilters): void {
    if (filters === registrationFilters) return
    registrationRequest.current?.abort()
    setRegistrationReport(null)
    setRegistrationLoading(true)
    setRegistrationError('')
    setRegistrationFilters(filters)
  }

  function applyRegistrationFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    updateRegistrationFilters(registrationDraft)
  }
  function resetRegistrationFilters(): void {
    setRegistrationDraft(EMPTY_REGISTRATION_FILTERS)
    updateRegistrationFilters(EMPTY_REGISTRATION_FILTERS)
  }

  async function changeOverride(row: ModelGovernanceRow, value: string) {
    if (selectedUser === '') return
    const key = modelKey(row)
    setOverridePending(key)
    try {
      const allowed = value === 'inherit' ? null : value === 'allow'
      await setModelAccess(Number(selectedUser), row.provider, row.model, allowed)
      const access = await getModelAccess(Number(selectedUser))
      setOverrides(new Map(access.overrides.map(item => [modelKey(item), item.allowed])))
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setOverridePending('')
    }
  }

  const actions = (
    <div className="pageToolbar modelPageToolbar">
      <div className="segmented modelViewTabs" role="group" aria-label={t('viewTabsAria')}>
        <button type="button" aria-pressed={view === 'catalog'} onClick={() => changeView('catalog')}>{t('tabCatalog')}</button>
        <button type="button" aria-pressed={view === 'governance'} onClick={() => changeView('governance')}>{t('tabGovernance')}</button>
        <button type="button" aria-pressed={view === 'personal'} onClick={() => changeView('personal')}>{t('tabPersonal')}</button>
      </div>
    </div>
  )

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={loading || (models.length === 0 && modelsError !== '') ? undefined : t('pageMeta', { count: String(models.length) })}
        actions={actions}
      />
      <ErrorBanner message={view === 'personal' ? registrationError : modelsError || error} />
      {showDetails && userListError !== '' ? <>
        <ErrorBanner message={userListError} />
        <Button onClick={() => retryUserList(value => value + 1)}>{t('refresh')}</Button>
      </> : null}
      {activeView.status === 'catalog' ? (
        <OrganizationModelsEditor
          onChanged={modelSettingsChanged}
          prepareNextView={modelDetails.prepare}
        />
      ) : activeView.status === 'loading' ? (
        <PageLoading />
      ) : activeView.status === 'error' ? (
        <PageLoadFailure />
      ) : activeView.selection.tab === 'governance' ? (
        <activeView.details.ModelsGovernanceDetails
          loading={loading}
          failed={modelsError !== ''}
          models={models}
          users={users}
          usersLoaded={userList !== undefined}
          selectedUser={selectedUser}
          selected={selected}
          accessLoading={accessLoading}
          overrides={overrides}
          overridePending={overridePending}
          onSelectUser={setSelectedUser}
          error={error}
          onError={setError}
          reload={reload}
          onOverride={changeOverride}
          digestRead={activeView.digestRead}
        />
      ) : (
        <activeView.details.PersonalRegistrationAudit
          users={users}
          report={registrationReport}
          loading={registrationLoading}
          failed={registrationError !== ''}
          draft={registrationDraft}
          onDraft={setRegistrationDraft}
          onApply={applyRegistrationFilters}
          onReset={resetRegistrationFilters}
          onRefresh={() => { void reloadRegistrations() }}
        />
      )}
    </div>
  )
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
