import { ArrowUpRight, CheckCircle2, Folder, FolderKanban, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { createProject, listProjects, type Project } from '../api.ts'
import { ProjectDirectoryBrowser } from '../components/ProjectDirectoryBrowser.tsx'
import {
  Button,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as projectListZh, en as projectListEn, type ProjectListCopyKey } from './project-list.copy.ts'

function projectListT() {
  return translateCopy(adminLanguage(), { zh: projectListZh, en: projectListEn })
}

export function ProjectListPage() {
  const t = useMemo(() => projectListT(), [])
  const [projects, setProjects] = useState<Project[]>([])
  const [originFilter, setOriginFilter] = useState<'all' | 'admin' | 'user'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [createError, setCreateError] = useState('')
  const [name, setName] = useState('')
  const [createMode, setCreateMode] = useState<'managed' | 'existing'>('managed')
  const [selectedPath, setSelectedPath] = useState<string>()

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setProjects(await listProjects(originFilter === 'all' ? undefined : originFilter))
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [originFilter])

  useEffect(() => { void reload(true) }, [reload])

  function openCreate() {
    setCreateError('')
    setCreateMode('managed')
    setSelectedPath(undefined)
    setCreateOpen(true)
  }

  function closeCreate() {
    if (pending) return
    setCreateError('')
    setCreateOpen(false)
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setCreateError('')
    try {
      if (createMode === 'existing' && selectedPath === undefined) return
      await createProject(createMode === 'managed'
        ? { name: name.trim() }
        : { name: name.trim(), path: selectedPath })
      setName('')
      setCreateMode('managed')
      setSelectedPath(undefined)
      setCreateOpen(false)
      await reload()
    } catch (cause) {
      setCreateError(projectMessageFrom(cause))
    } finally {
      setPending(false)
    }
  }

  function selectDirectory(path: string) {
    setSelectedPath(path)
    setCreateError('')
    if (name.trim() === '') setName(directoryName(path))
  }

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={loading ? undefined : t('projectCount', { count: String(projects.length) })}
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>{t('createProject')}</Button>}
      />
      <ErrorBanner message={error} />
      <div className="segmented" role="group" aria-label={t('originFilterAria')}>
        <button type="button" aria-pressed={originFilter === 'all'} onClick={() => setOriginFilter('all')}>{t('filterAll')}</button>
        <button type="button" aria-pressed={originFilter === 'admin'} onClick={() => setOriginFilter('admin')}>{t('originAdmin')}</button>
        <button type="button" aria-pressed={originFilter === 'user'} onClick={() => setOriginFilter('user')}>{t('originUser')}</button>
      </div>
      <Section className="responsiveSection" title={t('sectionTitle')} meta={loading ? undefined : t('recordCount', { count: String(projects.length) })}>
        {loading ? <LoadingState label={t('loadingProjects')} /> : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={t('emptyTitle')}
            detail={t('emptyDetail')}
            action={<Button variant="primary" icon={Plus} onClick={openCreate}>{t('createProject')}</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>{t('colProject')}</th>
                    <th>{t('colOrigin')}</th>
                    <th>{t('colDirectory')}</th>
                    <th>{t('colMembers')}</th>
                    <th aria-label={t('colOpen')} />
                  </tr>
                </thead>
                <tbody>
                  {projects.map(project => (
                    <tr key={project.id}>
                      <td>
                        <Link className="projectLink" to={`/projects/${project.id}`}>
                          <Folder aria-hidden="true" />
                          <span>{project.name}</span>
                        </Link>
                      </td>
                      <td>
                        <div className="projectOriginCell">
                          <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? t('originUser') : t('originAdmin')}</StatusBadge>
                          <span>{project.owner?.displayName || project.owner?.username || t('ownerFallback')}</span>
                        </div>
                      </td>
                      <td><span className="pathText">{project.path}</span></td>
                      <td><StatusBadge tone={project.memberCount === 0 ? 'neutral' : 'info'}>{t('membersCount', { count: String(project.memberCount) })}</StatusBadge></td>
                      <td className="alignRight"><Link className="iconLink" to={`/projects/${project.id}`} aria-label={t('openProjectAria', { name: project.name })} title={t('openProjectTitle')}><ArrowUpRight aria-hidden="true" /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {projects.map(project => (
                <Link className="mobileItem mobileProjectLink" key={project.id} to={`/projects/${project.id}`}>
                  <div className="mobileItemHeader">
                    <div className="projectIdentity">
                      <span className="itemIcon"><Folder aria-hidden="true" /></span>
                      <span><strong>{project.name}</strong><span>ID {project.id}</span></span>
                    </div>
                    <ArrowUpRight className="mobileChevron" aria-hidden="true" />
                  </div>
                  <div className="mobileItemBody">
                    <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? `${t('originUser')} · ${project.owner?.displayName || project.owner?.username || t('unknownOwner')}` : t('originAdmin')}</StatusBadge>
                    <span className="pathText">{project.path}</span>
                    <StatusBadge tone={project.memberCount === 0 ? 'neutral' : 'info'}>{t('membersCount', { count: String(project.memberCount) })}</StatusBadge>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </Section>

      <Dialog
        open={createOpen}
        title={t('createProject')}
        description={t('createDialogDescription')}
        onClose={closeCreate}
        wide
        footer={(
          <>
            <Button type="button" onClick={closeCreate} disabled={pending}>{t('cancel')}</Button>
            <Button
              type="submit"
              form="create-project-form"
              variant="primary"
              loading={pending}
              disabled={createMode === 'existing' && selectedPath === undefined}
            >
              {t('submitCreate')}
            </Button>
          </>
        )}
      >
        <form id="create-project-form" className="formGrid projectCreateForm" onSubmit={event => void onCreate(event)}>
          <div className="formSpanFull"><ErrorBanner message={createError} /></div>
          <Field
            label={t('projectNameLabel')}
            hint={createMode === 'managed' ? t('nameHintManaged') : t('nameHintExisting')}
            className="formSpanFull"
          >
            <input className="input" required autoFocus value={name} onChange={event => { setName(event.target.value); setCreateError('') }} placeholder={t('namePlaceholder')} />
          </Field>
          <fieldset className="field projectDirectoryField formSpanFull">
            <legend className="fieldLabel">{t('directoryFieldLabel')}</legend>
            <div className="segmented" role="group" aria-label={t('directoryModeAria')}>
              <button
                type="button"
                aria-pressed={createMode === 'managed'}
                onClick={() => { setCreateMode('managed'); setCreateError('') }}
              >
                {t('modeManaged')}
              </button>
              <button
                type="button"
                aria-pressed={createMode === 'existing'}
                onClick={() => { setCreateMode('existing'); setCreateError('') }}
              >
                {t('modeExisting')}
              </button>
            </div>
            {createMode === 'managed' ? (
              <div className="managedDirectorySummary">
                <FolderKanban aria-hidden="true" />
                <span>
                  <strong>{t('managedTitle')}</strong>
                  <small>{t('managedDetail')}</small>
                </span>
              </div>
            ) : (
              <>
                {selectedPath === undefined ? null : (
                  <div className="selectedDirectory">
                    <CheckCircle2 aria-hidden="true" />
                    <span>
                      <small>{t('selectedDirectory')}</small>
                      <strong title={selectedPath}>{selectedPath}</strong>
                    </span>
                  </div>
                )}
                <ProjectDirectoryBrowser selectedPath={selectedPath} onSelect={selectDirectory} />
              </>
            )}
          </fieldset>
        </form>
      </Dialog>
    </div>
  )
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const PROJECT_ERROR_KEYS: Record<string, ProjectListCopyKey> = {
  'project-name-invalid': 'errorNameInvalid',
  'project-root-not-directory': 'errorRootNotDirectory',
  'project-path-outside-root': 'errorPathOutsideRoot',
  'project-path-not-absolute': 'errorPathNotAbsolute',
  'project-path-reserved': 'errorPathReserved',
  'project-path-overlap': 'errorPathOverlap',
  'project-path-not-found': 'errorPathNotFound',
  'project-path-not-directory': 'errorPathNotDirectory',
  'project-path-inaccessible': 'errorPathInaccessible',
}

function projectMessageFrom(cause: unknown): string {
  const message = messageFrom(cause)
  const key = PROJECT_ERROR_KEYS[message]
  if (key !== undefined) return projectListT()(key)
  if (message.startsWith('duplicate project name')) return projectListT()('errorDuplicateName')
  return message
}

function directoryName(path: string): string {
  return path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? ''
}
