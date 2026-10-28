import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, focusWithoutRing, IconChevronRightOutline14, IconModelOutline16, IconFolderOpenOutline16,
  IconLoadingOutline16, IconPersonalizationOutline16, IconSettingsOutline16, IconShareOutline16,
  IconUserOutline16, useMediaQuery,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { requestSettingsSection } from '@deepseek-ai/dsh-client-runtime/client'
import type { ProjectConfiguration, ProjectMembership, ProjectSshTarget, ProjectThemePolicy } from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
import { CollaborationDialog } from './CollaborationDialog.tsx'
import css from './ProjectSettingsModal.module.css'

/** User-facing logical project settings panel. Filesystem operations stay in /admin. */
export interface ProjectSettingsModalProps {
  open: boolean
  project: ProjectMembership
  t: (key: CollaborationKey, params?: Record<string, string | number>) => string
  load: (projectId: number) => Promise<ProjectConfiguration>
  setThemePolicy: (projectId: number, policy: ProjectThemePolicy) => Promise<ProjectConfiguration>
  /** Organization SSH targets with the project's share flags; managers only. */
  listSshTargets?: (projectId: number) => Promise<ProjectSshTarget[]>
  /** Toggle one target's share toward the project; managers only. */
  shareSshTarget?: (projectId: number, targetId: number, shared: boolean) => Promise<{ publicId: number; name: string; shared: boolean }>
  onMembers: () => void
  onClose: () => void
}

const THEME_OPTIONS: readonly ProjectThemePolicy[] = ['follow-user', 'light', 'dark']
const CATEGORIES = [
  { id: 'overview', title: 'project.overviewTitle', hint: 'project.settingsDescription', Icon: IconFolderOpenOutline16 },
  { id: 'theme', title: 'project.themeNav', hint: 'project.themeDescription', Icon: IconPersonalizationOutline16 },
  { id: 'runtime', title: 'project.runtimeTitle', hint: 'project.runtimeHint', Icon: IconSettingsOutline16 },
  { id: 'models', title: 'project.modelsTitle', hint: 'project.modelsHint', Icon: IconModelOutline16 },
  { id: 'members', title: 'project.membersTitle', hint: 'project.membersHint', Icon: IconUserOutline16 },
  { id: 'ssh', title: 'project.sshTitle', hint: 'project.sshHint', Icon: IconShareOutline16 },
] as const

type Category = typeof CATEGORIES[number]['id']

/**
 * Render project facts and capability-gated settings with phone detail navigation.
 * @param props - Project identity, authoritative configuration operations, and existing settings entry points.
 * @returns The controlled project configuration dialog.
 */
export function ProjectSettingsModal({
  open, project, t, load, setThemePolicy, listSshTargets, shareSshTarget, onMembers, onClose,
}: ProjectSettingsModalProps) {
  const id = useId()
  const compact = useMediaQuery('(max-width: 767px)')
  const [category, setCategory] = useState<Category>('overview')
  const [configuration, setConfiguration] = useState<ProjectConfiguration>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [themeFailed, setThemeFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [sshReload, setSshReload] = useState(0)
  const [sshTargets, setSshTargets] = useState<ProjectSshTarget[]>()
  const [sshBusy, setSshBusy] = useState<number>()
  const [sshLoadFailed, setSshLoadFailed] = useState(false)
  const [sshError, setSshError] = useState<string>()
  const sectionHeading = useRef<HTMLHeadingElement>(null)
  const categoryLinks = useRef<Partial<Record<Category, HTMLButtonElement | null>>>({})
  const previousCategory = useRef<Category>('overview')

  useEffect(() => { if (open) setCategory('overview') }, [open, project.projectId])
  useLayoutEffect(() => {
    if (open && compact && previousCategory.current !== category) {
      const target = category === 'overview' ? categoryLinks.current[previousCategory.current] : sectionHeading.current
      if (target != null) focusWithoutRing(target)
    }
    previousCategory.current = category
  }, [open, compact, category])

  useEffect(() => {
    if (!open) return
    let active = true
    setConfiguration(undefined)
    setSshTargets(undefined)
    setSshError(undefined)
    setSshLoadFailed(false)
    setThemeFailed(false)
    setLoading(true)
    setLoadFailed(false)
    void load(project.projectId)
      .then((value) => { if (active) setConfiguration(value) })
      .catch(() => { if (active) setLoadFailed(true) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [load, open, project.projectId, reload])

  const themePolicy = configuration?.project.themePolicy ?? project.uiThemePolicy ?? 'follow-user'
  const isManager = configuration?.canManage === true
  const capabilities = configuration?.capabilities
  const canManageTheme = isManager && capabilities !== undefined && capabilities.themePolicy
  const canManageRuntime = isManager && capabilities !== undefined && capabilities.runtimeSettings
  const canManageModels = isManager && capabilities !== undefined && capabilities.projectModels
  const canManageSsh = isManager && capabilities !== undefined && capabilities.sshTargets
    && listSshTargets !== undefined && shareSshTarget !== undefined

  useEffect(() => {
    if (!open || !canManageSsh) return
    let active = true
    setSshLoadFailed(false)
    void listSshTargets(project.projectId)
      .then((value) => { if (active) setSshTargets(value) })
      .catch(() => { if (active) setSshLoadFailed(true) })
    return () => { active = false }
  }, [open, canManageSsh, listSshTargets, project.projectId, sshReload])

  const origin = configuration?.project.origin ?? project.origin
  const owner = configuration === undefined ? project.owner : configuration.project.owner
  const ownerName = origin === 'admin' ? t('project.organizationOwner')
    : owner == null ? t('project.ownerUnknown') : owner.displayName || owner.username
  const projectName = configuration?.project.name ?? project.name
  const selected = CATEGORIES.find(value => value.id === category) ?? CATEGORIES[0]
  const access = isManager ? t('project.managerAccess')
    : project.mode === 'rw' ? t('project.editorAccess') : t('project.readonlyAccess')
  const unavailable = (capability: boolean | undefined, key: CollaborationKey): string | undefined => {
    if (configuration === undefined) return undefined
    return !isManager ? t('project.managedByOwner') : capability !== true ? t(key) : undefined
  }

  const changeTheme = (next: ProjectThemePolicy): void => {
    if (!canManageTheme || saving || next === themePolicy) return
    setSaving(true)
    setThemeFailed(false)
    void setThemePolicy(project.projectId, next)
      .then((value) => { setConfiguration(value) })
      .catch(() => { setThemeFailed(true) })
      .finally(() => { setSaving(false) })
  }
  const openSection = (section: string): void => {
    onClose()
    requestSettingsSection(section, { scope: 'project', projectId: project.projectId })
  }
  const toggleSshTarget = (target: ProjectSshTarget, shared: boolean): void => {
    if (!canManageSsh || sshBusy !== undefined) return
    setSshBusy(target.publicId)
    setSshError(undefined)
    void shareSshTarget(project.projectId, target.publicId, shared)
      .then((updated) => {
        setSshTargets(current => current?.map(row =>
          row.publicId === updated.publicId ? { ...row, shared: updated.shared } : row))
      })
      .catch(() => { setSshError(t('project.sshShareFailed')) })
      .finally(() => { setSshBusy(undefined) })
  }

  return (
    <CollaborationDialog open={open} title={compact && category !== 'overview' ? t(selected.title) : t('project.settingsTitle')}
      description={projectName} closeLabel={t('manager.close')} onClose={onClose} wide
      bodyClassName={css.dialogBody}
      {...compact && category !== 'overview' ? { onBack: () => { setCategory('overview') }, backLabel: t('project.backOverview') } : {}}
      footer={<><span className={css.footerHint}>{category === 'theme' ? t('project.autoSave') : t('project.filesystemNote')}</span>
        <Button onClick={onClose}>{t('project.done')}</Button></>}>
      <div className={css.layout}>
        <nav className={css.navigation} aria-label={t('project.settingsTitle')}>
          {CATEGORIES.map(({ id: value, title, Icon }) => <button key={value} type="button" aria-current={category === value ? 'page' : undefined}
            onClick={() => { setCategory(value) }}><Icon size={16} /><span>{t(title)}</span></button>)}
        </nav>
        <div className={css.main}>
          {loading && <p className={css.queryStatus} role="status"><IconLoadingOutline16 size={16} />{t('project.loading')}</p>}
          {loadFailed && <div className={css.error} role="alert">{t('project.loadFailed')}
            <Button size="sm" onClick={() => { setReload(value => value + 1) }}>{t('scope.retry')}</Button></div>}
          <section aria-labelledby={`${id}-heading`}>
            <div className={css.sectionHeading}><h3 ref={sectionHeading} tabIndex={-1} id={`${id}-heading`}>{t(selected.title)}</h3>
              <p>{t(selected.hint)}</p></div>
            {category === 'overview' ? <>
              <dl className={css.facts}>
                <div><dt>{t('project.nameLabel')}</dt><dd>{projectName}</dd></div>
                <div><dt>{t('project.originLabel')}</dt><dd>{t(origin === 'admin' ? 'project.origin.admin' : origin === 'user' ? 'project.origin.user' : 'project.origin.unknown')}</dd></div>
                <div><dt>{t('project.ownerLabel')}</dt><dd>{ownerName}</dd></div>
                {configuration !== undefined && <div><dt>{t('project.accessLabel')}</dt><dd>{access}</dd></div>}
              </dl>
              <div className={css.categoryLinks}>{CATEGORIES.filter(value => value.id !== 'overview').map(({ id: value, title, hint, Icon }) => (
                <button key={value} type="button" ref={(node) => { categoryLinks.current[value] = node }} onClick={() => { setCategory(value) }}>
                  <span className={css.categoryIcon}><Icon size={18} /></span>
                  <span><strong>{t(title)}</strong><small>{t(hint)}</small></span>
                  <IconChevronRightOutline14 />
                </button>
              ))}</div>
            </> : category === 'theme' ? <>
              <div className={css.options} role="radiogroup" aria-label={t('project.themeTitle')}>
                {THEME_OPTIONS.map(option => <label key={option} className={css.option} data-selected={themePolicy === option}>
                  <input type="radio" name={`${id}-theme`} value={option} checked={themePolicy === option}
                    disabled={!canManageTheme || saving} onChange={() => { changeTheme(option) }} />
                  <span><strong>{t(`project.theme.${option}`)}</strong><small>{t(`project.theme.${option}.description`)}</small></span>
                </label>)}
              </div>
              {saving && <p className={css.queryStatus} role="status"><IconLoadingOutline16 size={16} />{t('project.savingTheme')}</p>}
              {themeFailed && <p className={css.error} role="alert">{t('project.themeFailed')}</p>}
              {unavailable(capabilities?.themePolicy, 'project.themeUnavailable') !== undefined && <p className={css.notice}>{unavailable(capabilities?.themePolicy, 'project.themeUnavailable')}</p>}
            </> : category === 'runtime' ? <>
              <p className={css.description}>{t('project.runtimeDescription')}</p>
              <div className={css.actions}>
                <Button variant="outline" disabled={!canManageRuntime} onClick={() => { openSection('plugins') }}><IconSettingsOutline16 size={16} />{t('project.openRuntime')}</Button>
                <Button variant="outline" disabled={!canManageRuntime} onClick={() => { openSection('agent-presets') }}><IconPersonalizationOutline16 size={16} />{t('project.openPresets')}</Button>
              </div>
              {unavailable(capabilities?.runtimeSettings, 'project.runtimeUnavailable') !== undefined && <p className={css.notice}>{unavailable(capabilities?.runtimeSettings, 'project.runtimeUnavailable')}</p>}
            </> : category === 'models' ? <>
              <p className={css.description}>{t('project.modelsDescription')}</p>
              <div className={css.actions}><Button variant="outline" disabled={!canManageModels} onClick={() => { openSection('models') }}><IconModelOutline16 size={16} />{t('project.openModels')}</Button></div>
              {unavailable(capabilities?.projectModels, 'project.modelsUnavailable') !== undefined && <p className={css.notice}>{unavailable(capabilities?.projectModels, 'project.modelsUnavailable')}</p>}
            </> : category === 'members' ? <>
              <p className={css.description}>{t('project.membersDescription')}</p>
              {project.kind === 'steward' && <p className={css.notice}>{t('manager.stewardNotice')}</p>}
              <div className={css.actions}><Button variant="outline" onClick={onMembers}><IconUserOutline16 size={16} />
                {isManager && capabilities?.members === true && project.kind !== 'steward' ? t('manager.membersAction') : t('manager.invitationsAction')}
              </Button></div>
              <p className={css.notice}>{t('project.memberAdminNote')}</p>
            </> : <>
              <p className={css.description}>{t('project.sshDescription')}</p>
              {canManageSsh && <div className={css.options} role="group" aria-label={t('project.sshTitle')}>
                {sshTargets === undefined && !sshLoadFailed && <p className={css.queryStatus} role="status"><IconLoadingOutline16 size={16} />{t('project.sshLoading')}</p>}
                {sshTargets?.map(target => <label key={target.publicId} className={css.option} data-selected={target.shared}>
                  <input type="checkbox" name={`${id}-ssh-${String(target.publicId)}`} checked={target.shared}
                    disabled={!target.enabled || sshBusy !== undefined}
                    onChange={(event) => { toggleSshTarget(target, event.currentTarget.checked) }} />
                  <span><strong>{target.name}</strong><small>{target.host}{target.enabled ? '' : ` · ${t('project.sshDisabled')}`}</small></span>
                  {sshBusy === target.publicId && <span className={css.busy} role="status" aria-label={t('manager.loading')}><IconLoadingOutline16 size={16} /></span>}
                </label>)}
                {sshTargets?.length === 0 && <p className={css.notice}>{t('project.sshEmpty')}</p>}
              </div>}
              {sshLoadFailed && <div className={css.error} role="alert">{t('project.sshLoadFailed')}<Button size="sm" onClick={() => { setSshReload(value => value + 1) }}>{t('scope.retry')}</Button></div>}
              {sshError !== undefined && <p className={css.error} role="alert">{sshError}</p>}
              {unavailable(capabilities?.sshTargets && listSshTargets !== undefined && shareSshTarget !== undefined, 'project.sshUnavailable') !== undefined && <p className={css.notice}>{unavailable(capabilities?.sshTargets && listSshTargets !== undefined && shareSshTarget !== undefined, 'project.sshUnavailable')}</p>}
            </>}
          </section>
        </div>
      </div>
    </CollaborationDialog>
  )
}
