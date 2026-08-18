import { ArrowUpRight, CheckCircle2, Folder, FolderKanban, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
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

export function ProjectListPage() {
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
        title="项目"
        description="统一查看管理员发起和用户发起的工作空间，并配置成员权限。"
        meta={loading ? undefined : `${projects.length} 个项目`}
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>新建项目</Button>}
      />
      <ErrorBanner message={error} />
      <div className="segmented" role="group" aria-label="项目来源筛选">
        <button type="button" aria-pressed={originFilter === 'all'} onClick={() => setOriginFilter('all')}>全部</button>
        <button type="button" aria-pressed={originFilter === 'admin'} onClick={() => setOriginFilter('admin')}>管理员发起</button>
        <button type="button" aria-pressed={originFilter === 'user'} onClick={() => setOriginFilter('user')}>用户发起</button>
      </div>
      <Section className="responsiveSection" title="项目目录" meta={loading ? undefined : `${projects.length} 条记录`}>
        {loading ? <LoadingState label="正在加载项目" /> : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="还没有项目"
            detail="管理员项目可使用默认目录或导入现有目录；用户项目由账户在受控项目根目录中创建。"
            action={<Button variant="primary" icon={Plus} onClick={openCreate}>新建项目</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>来源 / 所有者</th>
                    <th>目录</th>
                    <th>成员</th>
                    <th aria-label="打开" />
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
                          <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? '用户发起' : '管理员发起'}</StatusBadge>
                          <span>{project.owner?.displayName || project.owner?.username || '组织管理'}</span>
                        </div>
                      </td>
                      <td><span className="pathText">{project.path}</span></td>
                      <td><StatusBadge tone={project.memberCount === 0 ? 'neutral' : 'info'}>{project.memberCount} 位成员</StatusBadge></td>
                      <td className="alignRight"><Link className="iconLink" to={`/projects/${project.id}`} aria-label={`打开 ${project.name}`} title="打开项目"><ArrowUpRight aria-hidden="true" /></Link></td>
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
                    <StatusBadge tone={project.origin === 'user' ? 'info' : 'neutral'}>{project.origin === 'user' ? `用户发起 · ${project.owner?.displayName || project.owner?.username || '未知所有者'}` : '管理员发起'}</StatusBadge>
                    <span className="pathText">{project.path}</span>
                    <StatusBadge tone={project.memberCount === 0 ? 'neutral' : 'info'}>{project.memberCount} 位成员</StatusBadge>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </Section>

      <Dialog
        open={createOpen}
        title="新建项目"
        description="创建受管目录，或把 Gateway 主机上的现有项目加入工作区。"
        onClose={closeCreate}
        wide
        footer={(
          <>
            <Button type="button" onClick={closeCreate} disabled={pending}>取消</Button>
            <Button
              type="submit"
              form="create-project-form"
              variant="primary"
              loading={pending}
              disabled={createMode === 'existing' && selectedPath === undefined}
            >
              创建项目
            </Button>
          </>
        )}
      >
        <form id="create-project-form" className="formGrid projectCreateForm" onSubmit={event => void onCreate(event)}>
          <div className="formSpanFull"><ErrorBanner message={createError} /></div>
          <Field
            label="项目名称"
            hint={createMode === 'managed' ? 'Gateway 会在默认项目根目录创建同名目录。' : '用于工作区列表显示，不会重命名现有目录。'}
            className="formSpanFull"
          >
            <input className="input" required autoFocus value={name} onChange={event => { setName(event.target.value); setCreateError('') }} placeholder="例如：产品文档" />
          </Field>
          <fieldset className="field projectDirectoryField formSpanFull">
            <legend className="fieldLabel">项目目录</legend>
            <div className="segmented" role="group" aria-label="项目目录方式">
              <button
                type="button"
                aria-pressed={createMode === 'managed'}
                onClick={() => { setCreateMode('managed'); setCreateError('') }}
              >
                默认目录
              </button>
              <button
                type="button"
                aria-pressed={createMode === 'existing'}
                onClick={() => { setCreateMode('existing'); setCreateError('') }}
              >
                现有目录
              </button>
            </div>
            {createMode === 'managed' ? (
              <div className="managedDirectorySummary">
                <FolderKanban aria-hidden="true" />
                <span>
                  <strong>Gateway 默认项目目录</strong>
                  <small>创建一个新的受管项目文件夹</small>
                </span>
              </div>
            ) : (
              <>
                {selectedPath === undefined ? null : (
                  <div className="selectedDirectory">
                    <CheckCircle2 aria-hidden="true" />
                    <span>
                      <small>已选择目录</small>
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

function projectMessageFrom(cause: unknown): string {
  const message = messageFrom(cause)
  if (message === 'project-name-invalid') {
    return '项目名称不能为空，也不能包含路径分隔符。'
  }
  if (message === 'project-root-not-directory') {
    return '项目根路径不是目录，请检查 Gateway 配置。'
  }
  if (message === 'project-path-outside-root') {
    return '项目目录不在 Gateway 允许的项目根目录内。'
  }
  if (message === 'project-path-not-absolute') {
    return '项目目录必须是 Gateway 主机上的绝对路径。'
  }
  if (message === 'project-path-reserved') {
    return '不能把 Gateway 数据、凭据、运行时或用户目录登记为项目。'
  }
  if (message === 'project-path-overlap') {
    return '该目录与已登记项目重叠，请选择其他目录。'
  }
  if (message === 'project-path-not-found') {
    return '目录不存在。请先在 Gateway 主机上创建该目录，再登记为项目。'
  }
  if (message === 'project-path-not-directory') {
    return '该路径不是目录。请填写 Gateway 主机上的现有目录。'
  }
  if (message === 'project-path-inaccessible') {
    return 'Gateway 无权访问该目录，请检查目录权限。'
  }
  if (message.startsWith('duplicate project name')) return '项目名称已存在。'
  return message
}

function directoryName(path: string): string {
  return path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? ''
}
