/** On-demand preparation and publication of an existing project on its owning computer. */
import { useEffect, useRef, useState } from 'react'
import { nodeMigrationChoicesSchema, nodeMigrationPreflightSchema, type NodeMigrationBlocker, type NodeMigrationChoices, type NodeMigrationPreflight } from '../../../src/node-content-migration-protocol.ts'
import { adminComputerRequestUrl, adminComputerTarget } from '../computer-target.ts'
import { Button, Dialog, ErrorBanner, Field, Section } from '../components/ui.tsx'
import { adminLanguage } from '../language.ts'
import { ProjectSourceReview } from './ProjectSourceReview.tsx'

type Action = 'open' | 'more' | 'check' | 'prepare' | 'publish'
const prefix = '/admin/api/deployment/project-content-migrations'
const blockers: Record<NodeMigrationBlocker, readonly [string,string]> = {
  'volume-unavailable': ['目标内容库不可用。请检查本机数据库配置。', 'Check the content database on this computer.'],
  'adapters-missing': ['此电脑缺少所需的存储服务。', 'Required project storage services are missing on this computer.'],
  'names-incomplete': ['请先完成组织项目名称索引。', 'Complete the organization’s project name index.'],
  'node-unavailable': ['请先恢复项目所属电脑的连接。', 'Reconnect the computer that owns this project.'],
  'runtime-busy': ['Runtime 仍在运行或尚未确认停止。请等待任务完成。', 'The Runtime is running or its stop is unconfirmed. Let active work finish.'],
  'progress-busy': ['等项目进度任务完成后再切换。', 'Wait for the project progress job to finish.'],
  'prepare-required': ['请先准备并核验项目副本。', 'Prepare and verify a project copy first.'],
  'source-changed': ['准备后项目内容已有更新。请重新准备副本。', 'Project content changed after preparation. Prepare a fresh copy.'],
  'archive-files-unverified': ['部分归档文件缺少来源核验。', 'Some archived files still need their original storage verified.'],
}

/** Preserve the current Admin document’s computer across selection, review and publication. */
export function NodeContentMigrationSection() {
  const target = adminComputerTarget(globalThis.location.pathname)
  return <MigrationControls key={target ?? 'entry'} target={target} />
}

function MigrationControls({target}: {target: string | undefined}) {
  const language = adminLanguage() === 'zh' ? 0 : 1
  const t = (zh: string, en: string) => [zh,en][language]!
  const [choices, setChoices] = useState<NodeMigrationChoices | null>(null)
  const [selected, setSelected] = useState('')
  const [view, setView] = useState<NodeMigrationPreflight | null>(null)
  const [actionInFlight, setActionInFlight] = useState<Action | null>(null), [error, setError] = useState(''), [confirm, setConfirm] = useState(false)
  const busy = actionInFlight !== null
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [])

  async function run(action: Action) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setActionInFlight(action); setError('')
    try {
      const directory = action === 'open' || action === 'more'
      const id = Number(selected)
      if (!directory && !id) return
      const method = action === 'prepare' || action === 'publish' ? 'POST' : 'GET'
      const query = new URLSearchParams()
      if (action === 'more' && choices?.next) query.set('after', String(choices.next))
      const node = method === 'POST' ? view?.nodeId : target
      if (node) query.set('dshNode', node)
      const suffix = directory ? '' : `/${id}${method === 'POST' ? `/${action}` : ''}`
      const url = adminComputerRequestUrl(prefix + suffix + (query.size ? `?${query}` : ''), undefined, 'computer')
      let body: string | undefined
      if (method === 'POST') {
        if (!view || view.projectId !== id || (target && target !== view.nodeId)) throw new Error(t('请重新检查所选项目。','Check the selected project again.'))
        const targetFields = {nodeId: view.nodeId, runtimeId: view.runtimeId}
        if (action === 'publish' && (!view.canPublish || !view.snapshot)) return
        body = JSON.stringify(action === 'publish' ? {...targetFields, generation:view.generation, snapshot:view.snapshot} : targetFields)
      }
      const response = await fetch(url, {method, credentials:'same-origin', cache:'no-store', signal:controller.signal,
        ...(body ? {headers:{'content-type':'application/json'}, body} : {})})
      if (!response.ok) {
        if (response.status === 403) throw new Error(t('当前账号无权管理此项目。','Your account cannot manage this project.'))
        if (response.status === 409) throw new Error(t('项目状态已变化，请重新检查后再继续。','The project state changed. Check it again before continuing.'))
        throw new Error(t('未能完成操作。请检查本机服务后重试。','The operation could not finish. Check the local services and retry.'))
      }
      const result: unknown = await response.json()
      if (controller.signal.aborted) return
      if (directory) {
        const page = nodeMigrationChoicesSchema.parse(result)
        setChoices(previous => ({items:action === 'more' ? [...(previous?.items ?? []),...page.items] : page.items,next:page.next}))
      } else {
        const updated = nodeMigrationPreflightSchema.parse(result)
        if (updated.projectId !== id || node && updated.nodeId !== node || method === 'POST' && updated.runtimeId !== view?.runtimeId) {
          throw new Error(t('电脑或项目身份不一致，请重新检查。','The computer or project changed. Check it again.'))
        }
        setView(updated)
        if (action === 'publish') setConfirm(false)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && cause.name === 'Error' ? cause.message : t('未能读取项目状态，请重试。','Could not read the project state. Try again.'))
        if (action === 'publish' || action === 'prepare') { setConfirm(false); setView(null) }
      }
    } finally {
      if (!controller.signal.aborted) setActionInFlight(null)
      request.current = null
    }
  }

  const label = choices?.items.find(row => row.id === Number(selected))?.name ?? `#${selected}`
  const status = view?.sourceRetirement === 'retiring' ? t('项目已在本机内容库运行。旧数据库仍保留历史副本，或其处置仍待核验。','The project now uses local storage. The original database still retains a historical copy or its removal awaits verification.')
    : view?.storage === 'node' ? t('项目使用本机内容库。','This project uses local storage.')
    : view?.snapshot ? t('已准备副本。当前项目仍使用原存储。','A copy is prepared. The project still uses its original storage.')
    : t('项目使用原存储。','This project uses its original storage.')
  return <Section title={t('项目内容迁移','Project storage migration')}>
    <p className="fieldHint">{t('将现有项目迁入所属电脑的内容库。准备副本时，成员可以照常工作。', 'Move an existing project into its computer’s content database. Members can keep working while the copy is prepared.')}</p>
    {!choices ? <Button type="button" disabled={busy} loading={busy} onClick={() => void run('open')}>{t('选择项目','Choose a project')}</Button> : <>
      {choices.items.length ? <Field label={t('本机项目','Projects on this computer')}><select className="input" aria-label={t('本机项目','Projects on this computer')}
        disabled={busy} value={selected} onChange={event => { setSelected(event.target.value); setView(null); setError(''); setConfirm(false) }}>
        <option value="">{t('选择项目','Choose a project')}</option>
        {choices.items.map(item => <option key={item.id} value={item.id}>{item.name ? `${item.name} · #${item.id}` : `#${item.id}`}</option>)}
      </select></Field> : <p>{t('这台电脑还没有协作项目。','There are no collaborative projects on this computer.')}</p>}
      <div className="formActions">
        {choices.next && <Button type="button" disabled={busy} onClick={() => void run('more')}>{t('显示更多项目','Show more projects')}</Button>}
        {selected && !view && <Button type="button" disabled={busy} loading={actionInFlight==='check'} onClick={() => void run('check')}>{t('检查项目','Check project')}</Button>}
      </div>
    </>}
    {view && <><p role="status">{status}</p>
      {view.blockers.length > 0 && <ul>{view.blockers.map(key => <li key={key}>{blockers[key][language]}</li>)}</ul>}
      {view.storage==='node' && (view.sourceRetirement==='retiring' || view.sourceRetirement==='retired') &&
        <ProjectSourceReview key={view.nodeId+'/'+view.projectId+'/'+view.runtimeId} project={view} />}
      <div className="formActions">
        <Button type="button" disabled={busy} loading={actionInFlight==='check'} onClick={() => void run('check')}>{t('重新检查','Recheck')}</Button>
        {view.storage==='shared' && <><Button type="button" disabled={busy || !view.canPrepare} loading={actionInFlight==='prepare'} onClick={() => void run('prepare')}>{view.snapshot ? t('重新准备副本','Prepare a fresh copy') : t('准备副本','Prepare copy')}</Button>
        {view.snapshot && <Button type="button" variant="primary" disabled={busy || !view.canPublish} onClick={() => setConfirm(true)}>{t('切换项目存储','Switch project storage')}</Button>}
        </>}
      </div>
    </>}
    <ErrorBanner message={error} />
    <Dialog open={confirm} title={t('切换项目存储','Switch project storage')} onClose={() => { if (!busy) setConfirm(false) }}
      footer={<><Button disabled={busy} onClick={() => setConfirm(false)}>{t('取消','Cancel')}</Button><Button variant="primary" disabled={!view?.canPublish} loading={busy} onClick={() => void run('publish')}>{t('确认切换','Confirm switch')}</Button></>}>
      <p>{t(`“${label}”将使用所属电脑的内容库。提交时会再次核验副本和 Runtime 停止状态。历史副本单独保留。`, `“${label}” will use the content database on its computer. The Gateway will verify the copy and stopped Runtime again. The historical copy is retained separately.`)}</p>
    </Dialog>
  </Section>
}
