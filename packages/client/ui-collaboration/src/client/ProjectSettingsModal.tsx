import { useEffect, useState } from 'react'
import {
  Button, IconDataOutline16, IconFolderOpenOutline16, IconPersonalizationOutline16,
  IconSettingsOutline16, IconShareOutline16, IconUserOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { requestSettingsSection } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ProjectConfiguration, ProjectMembership, ProjectSshTarget, ProjectThemePolicy,
} from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
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

/** Render project-owned settings without exposing host paths or raw documents. */
export function ProjectSettingsModal({
  open, project, t, load, setThemePolicy, listSshTargets, shareSshTarget, onMembers, onClose,
}: ProjectSettingsModalProps) {
  const [configuration, setConfiguration] = useState<ProjectConfiguration>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [sshTargets, setSshTargets] = useState<ProjectSshTarget[]>()
  const [sshBusy, setSshBusy] = useState<number>()
  const [sshError, setSshError] = useState<string>()

  useEffect(() => {
    if (!open) return
    let active = true
    setConfiguration(undefined)
    setSshTargets(undefined)
    setSshError(undefined)
    setLoading(true)
    setError(undefined)
    void load(project.projectId)
      .then((value) => { if (active) setConfiguration(value) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [load, open, project.projectId])

  const themePolicy = configuration?.project.themePolicy ?? project.uiThemePolicy ?? 'follow-user'
  const isManager = configuration?.canManage === true
  const capabilities = configuration?.capabilities
  const canManageTheme = isManager && capabilities !== undefined && capabilities.themePolicy
  const canManageRuntime = isManager && capabilities !== undefined && capabilities.runtimeSettings
  const canManageModels = isManager && capabilities !== undefined && capabilities.projectModels
  const canManageSsh = isManager && capabilities !== undefined && capabilities.sshTargets
    && listSshTargets !== undefined && shareSshTarget !== undefined

  // The target list loads only after the configuration confirms the manager
  // capability — the account endpoint refuses ordinary members anyway.
  useEffect(() => {
    if (!open || !canManageSsh) return
    let active = true
    void listSshTargets(project.projectId)
      .then((value) => { if (active) setSshTargets(value) })
      .catch((cause: unknown) => { if (active) setSshError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false }
  }, [open, canManageSsh, listSshTargets, project.projectId])
  const projectType = project.origin === 'admin' ? t('project.adminProject') : t('project.userProject')
  const owner = configuration === undefined ? project.owner : configuration.project.owner
  const ownerName = owner === undefined || owner === null
    ? t('project.organizationOwner')
    : owner.displayName || owner.username

  const changeTheme = (next: ProjectThemePolicy): void => {
    if (!canManageTheme || saving || next === themePolicy) return
    setSaving(true)
    setError(undefined)
    void setThemePolicy(project.projectId, next)
      .then((value) => { setConfiguration(value) })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)) })
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
    <Modal
      open={open}
      onClose={onClose}
      title={t('project.settingsTitle')}
      closeLabel={t('manager.close')}
      description={t('project.settingsDescription')}
      className={css.modal ?? ''}
      contentClassName={css.content ?? ''}
      footer={(
        <Button variant="outline" onClick={onClose}>{t('manager.close')}</Button>
      )}
    >
      <div className={css.identity}>
        <div>
          <strong>{project.name}</strong>
          <span>{projectType}</span>
          <span>{t('project.owner', { name: ownerName })}</span>
        </div>
        <span className={isManager ? css.managerBadge : css.readonlyBadge}>
          {isManager ? t('project.manager') : t('project.viewer')}
        </span>
      </div>

      {loading ? <p className={css.status} role="status">{t('project.loading')}</p> : null}
      {error !== undefined ? <p className={css.error} role="alert">{error}</p> : null}

      <section className={css.section} aria-labelledby="project-theme-policy-title">
        <div className={css.sectionHeading}>
          <div className={css.icon}><IconPersonalizationOutline16 size={16} /></div>
          <div>
            <h3 id="project-theme-policy-title">{t('project.themeTitle')}</h3>
            <p>{t('project.themeDescription')}</p>
          </div>
        </div>
        <div className={css.options} role="radiogroup" aria-label={t('project.themeTitle')}>
          {THEME_OPTIONS.map(option => (
            <label key={option} className={css.option} data-selected={themePolicy === option}>
              <input
                type="radio"
                name={`project-theme-${String(project.projectId)}`}
                value={option}
                checked={themePolicy === option}
                disabled={!canManageTheme || saving}
                onChange={() => { changeTheme(option) }}
              />
              <span>
                <strong>{t(`project.theme.${option}`)}</strong>
                <small>{t(`project.theme.${option}.description`)}</small>
              </span>
            </label>
          ))}
        </div>
        {!isManager
          ? <p className={css.notice}>{t('project.managedByOwner')}</p>
          : capabilities === undefined || !capabilities.themePolicy
            ? <p className={css.notice}>{t('project.themeUnavailable')}</p>
            : null}
      </section>

      <section className={css.section} aria-labelledby="project-runtime-title">
        <div className={css.sectionHeading}>
          <div className={css.icon}><IconSettingsOutline16 size={16} /></div>
          <div>
            <h3 id="project-runtime-title">{t('project.runtimeTitle')}</h3>
            <p>{t('project.runtimeDescription')}</p>
          </div>
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={!canManageRuntime} onClick={() => { openSection('plugins') }}>
            <IconSettingsOutline16 size={14} />{t('project.openRuntime')}
          </Button>
          <Button variant="outline" size="sm" disabled={!canManageRuntime} onClick={() => { openSection('agent-presets') }}>
            <IconPersonalizationOutline16 size={14} />{t('project.openPresets')}
          </Button>
        </div>
        {!isManager
          ? <p className={css.notice}>{t('project.runtimeManagedByOwner')}</p>
          : capabilities === undefined || !capabilities.runtimeSettings
            ? <p className={css.notice}>{t('project.runtimeUnavailable')}</p>
            : null}
      </section>

      <section className={css.section} aria-labelledby="project-models-title">
        <div className={css.sectionHeading}>
          <div className={css.icon}><IconDataOutline16 size={16} /></div>
          <div>
            <h3 id="project-models-title">{t('project.modelsTitle')}</h3>
            <p>{t('project.modelsDescription')}</p>
          </div>
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={!canManageModels} onClick={() => { openSection('models') }}>
            <IconDataOutline16 size={14} />{t('project.openModels')}
          </Button>
        </div>
        {!isManager
          ? <p className={css.notice}>{t('project.modelsManagedByOwner')}</p>
          : capabilities === undefined || !capabilities.projectModels
            ? <p className={css.notice}>{t('project.modelsUnavailable')}</p>
            : null}
      </section>

      <section className={css.section} aria-labelledby="project-members-title">
        <div className={css.sectionHeading}>
          <div className={css.icon}><IconUserOutline16 size={16} /></div>
          <div>
            <h3 id="project-members-title">{t('project.membersTitle')}</h3>
            <p>{t('project.membersDescription')}</p>
          </div>
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" onClick={onMembers}>
            <IconUserOutline16 size={14} />{isManager ? t('manager.membersAction') : t('manager.invitationsAction')}
          </Button>
        </div>
      </section>

      <section className={css.section} aria-labelledby="project-ssh-title">
        <div className={css.sectionHeading}>
          <div className={css.icon}><IconShareOutline16 size={16} /></div>
          <div>
            <h3 id="project-ssh-title">{t('project.sshTitle')}</h3>
            <p>{t('project.sshDescription')}</p>
          </div>
        </div>
        {canManageSsh
          ? (
            <div className={css.options} role="group" aria-label={t('project.sshTitle')}>
              {sshTargets === undefined && sshError === undefined
                ? <p className={css.notice}>{t('project.sshLoading')}</p>
                : null}
              {sshTargets?.map(target => (
                <label key={target.publicId} className={css.option} data-selected={target.shared}>
                  <input
                    type="checkbox"
                    name={`project-ssh-${String(project.projectId)}-${String(target.publicId)}`}
                    checked={target.shared}
                    disabled={!target.enabled || sshBusy !== undefined}
                    onChange={(event) => { toggleSshTarget(target, event.currentTarget.checked) }}
                  />
                  <span>
                    <strong>{target.name}</strong>
                    <small>{target.host}{target.enabled ? '' : ` · ${t('project.sshDisabled')}`}</small>
                  </span>
                </label>
              ))}
              {sshTargets !== undefined && sshTargets.length === 0
                ? <p className={css.notice}>{t('project.sshEmpty')}</p>
                : null}
            </div>
          )
          : null}
        {sshError !== undefined ? <p className={css.error} role="alert">{sshError}</p> : null}
        {!isManager
          ? <p className={css.notice}>{t('project.sshManagedByOwner')}</p>
          : capabilities === undefined || !capabilities.sshTargets
            ? <p className={css.notice}>{t('project.sshUnavailable')}</p>
            : null}
      </section>

      <p className={css.filesystemNote}>
        <IconFolderOpenOutline16 size={15} />{t('project.filesystemNote')}
      </p>
    </Modal>
  )
}
