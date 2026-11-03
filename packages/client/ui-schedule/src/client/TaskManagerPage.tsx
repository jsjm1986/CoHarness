/** Cross-session retained reminders with local search and selection. */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconClockOutline16, IconCloseOutline16, IconPlusOutline16, IconSearchOutline16,
  IconChevronDownOutline14, Input, Menu, ComputerBadge,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogSnapshot } from './catalog-source.ts'
import { CatalogFeedback } from './CatalogFeedback.tsx'
import { TaskDetail, useTaskDetail, type TaskDetailInjected } from './TaskDetail.tsx'
import { useRelativeClock } from './relative-clock.ts'
import { formatScheduleFrequency, nextRunParts, taskName, zoneLabel } from './schedule-format.ts'
import type { FrequencyZone } from './schedule-format.ts'
import type { TaskEnvironment,TaskEnvironments } from './task-environments.ts'
import css from './TaskManagerPage.module.css'

/** Injected catalog and task actions for the management page. */
export interface TaskPageActions extends TaskDetailInjected {
  /** Create a conversation in this action set's captured Runtime. */
  readonly onNewTask: (signal?: AbortSignal) => void | Promise<void>
}

/** Catalogs and explicit Runtime choices, without changing conversation selection. */
export interface TaskManagerInjected extends TaskPageActions {
  /** Host task catalog with its query and deletion state. */
  readonly hooks: {
    readonly catalog: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>>
    readonly taskEnvironments: HostObservable<TaskEnvironments>
  }
  /** Stable Runtime source resolvers bound by the renderer. */
  readonly keyedHooks: { readonly taskCatalog:(key:string)=>HostObservable<CatalogSnapshot<ScheduleCatalogEntry>> }
  /** Read, mutation and creation actions captured for the selected Runtime. */
  readonly taskActionsForRuntime:(key:string)=>TaskPageActions
  /** Refresh authorized directory metadata without starting a Runtime. */
  readonly refreshTaskEnvironments:()=>Promise<void>
}

/** Root-scoped task catalog props derived from the framework and injected actions. */
export type TaskManagerPageProps = PropsRuntime<'main'>
  & InjectFace<TaskManagerInjected>
  & PropsLocale<'schedule.manager'>

type StatusFilter = 'all' | ScheduleCatalogEntry['status']

const UNAVAILABLE_CATALOG:CatalogSnapshot<ScheduleCatalogEntry>={ records:[],status:'error',deleting:[],settled:false,readRequest:0,readSettled:0 }

/**
 * Render retained tasks with authoritative deletion and timing-only edits.
 * @param props - framework catalog snapshot, localized copy, and action callbacks.
 * @returns the searchable task list beside the selected task's detail.
 */
export function TaskManagerPage(props: TaskManagerPageProps) {
  const { useTaskCatalog, useTaskEnvironments, taskActionsForRuntime, refreshTaskEnvironments, t } = props
  const environments=useTaskEnvironments(snapshot=>snapshot)
  const [environmentKey,setEnvironmentKey]=useState<TaskEnvironment['key']>('base')
  const [chosenEnvironment,setChosenEnvironment]=useState<TaskEnvironment>()
  const [environmentMenu,setEnvironmentMenu]=useState(false)
  const [environmentSearch,setEnvironmentSearch]=useState('')
  const [creating,setCreating]=useState(false)
  const [creationFailed,setCreationFailed]=useState(false)
  const viewLifetime=useRef<AbortController|null>(null)
  if(viewLifetime.current===null)viewLifetime.current=new AbortController()
  useEffect(()=>{
    if(viewLifetime.current?.signal.aborted)viewLifetime.current=new AbortController()
    const active=viewLifetime.current
    return()=>{active?.abort()}
  },[])
  const selectedActions=taskActionsForRuntime(environmentKey)
  const { onNewTask,onRetry }=selectedActions
  const activeEnvironment=environments.choices.find(item=>item.key===environmentKey)
  const shownEnvironment=activeEnvironment??chosenEnvironment
  const unavailable=activeEnvironment===undefined||!activeEnvironment.available
  const answer=useTaskCatalog(environmentKey,snapshot=>snapshot)??UNAVAILABLE_CATALOG
  const catalog=unavailable?{ ...answer,status:'error' as const }:answer
  const { records, status } = catalog
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedId, setSelectedId] = useState<ScheduleId | null>(null)
  // The rows state how long remains, so they read the shared ticking clock
  // rather than a value sampled at mount: a catalog refresh can move the target
  // this text describes.
  const now = useRelativeClock()
  const detail = useTaskDetail({ ...props,...selectedActions }, catalog, selectedId ?? undefined)
  const { record: catalogRecord, task: selected, id: detailId, confirmId, setConfirmId, setTab } = detail
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const confirming = records.find(record => record.id === confirmId)
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return records.filter(record => (
      (statusFilter === 'all' || record.status === statusFilter)
      && (record.prompt.toLowerCase().includes(query)
        || record.sessionId.toLowerCase().includes(query)
        || taskName(record).toLowerCase().includes(query))
    )).toSorted((left, right) =>
      Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))
  }, [records, search, statusFilter])

  // An inactive-only filter is its own empty state: no task is inactive, rather than no task matched.
  const emptyTitle = statusFilter === 'inactive' && search.trim() === ''
    ? 'list.emptyInactive'
    : records.length === 0 ? 'list.empty' : 'list.noMatches'
  // The list's frequency line omits a rule zone equal to the host's and otherwise
  // names it, the same way the detail's Repeat row does.
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const frequencyZone: FrequencyZone = { system: systemZone, label: zone => zoneLabel(zone, t) }
  const frequency = (record: ScheduleCatalogEntry): string => formatScheduleFrequency(record, t, frequencyZone)

  useEffect(() => {
    // The detail focuses its own panel; with nothing selected, focus returns
    // to the row that opened it, or to the page heading once that row is gone.
    if (selectedId !== null) return
    if (rowRef.current !== null) {
      const target = rowRef.current.isConnected ? rowRef.current : headingRef.current
      target?.focus()
      rowRef.current = null
    }
  }, [selectedId])

  useEffect(() => {
    if (status !== 'ready') return
    if (selectedId !== null && selected === undefined) setSelectedId(null)
    if (confirmId !== null && confirming === undefined) setConfirmId(null)
  }, [status, selectedId, selected, confirmId, confirming])

  const closeDetails = (): void => {
    setSelectedId(null)
  }
  const createTask=():void=>{
    if(creating||unavailable||answer.unsupported===true)return
    const lifetime = viewLifetime.current
    if (lifetime === null || lifetime.signal.aborted) return
    setCreating(true);setCreationFailed(false)
    const signal = lifetime.signal
    try{
      const pending=onNewTask(signal)
      if(pending===undefined){setCreating(false);return}
      void pending.catch(()=>{if(!signal.aborted)setCreationFailed(true)})
        .finally(()=>{if(!signal.aborted)setCreating(false)})
    }catch(_error:unknown){setCreationFailed(true);setCreating(false)}
  }
  const switchDisabled=selectedId!==null||creating||catalog.deleting.length>0
  const choices = environments.choices.filter((item) => {
    const name = environments.showComputer ? item.name ?? '' : ''
    const project = item.target?.kind === 'project' ? item.target.projectName ?? '' : ''
    return `${name} ${project} ${item.target?.runtimeId ?? ''}`.toLowerCase().includes(environmentSearch.trim().toLowerCase())
  })
  const environmentLabel=(item:TaskEnvironment):string=>{
    const owner=item.target?.kind==='project'?item.target.projectName??t('environment.project'):t('environment.personal')
    if(!environments.showComputer)return item.target?.runtimeId===undefined?owner:`${owner} · ${item.target.runtimeId.slice(0,8)}`
    const name=item.name??t('environment.current')
    const duplicates = environments.choices.filter(choice => choice.target?.nodeId !== undefined
      && choice.target.nodeId === item.target?.nodeId).length
    if(item.target?.kind==='project')return `${owner} · ${name}`
    return duplicates>1&&item.target?.runtimeId!==undefined?`${name} · ${item.target.runtimeId.slice(0,8)}`:name
  }

  return (
    <section
      className={clsx(css.page, selected !== undefined && css.hasDetails)}
      aria-label={t('title')}
      data-testid="task-manager-page"
      onKeyDown={(event) => {
        // A dropdown that closed on this Escape has already consumed the key: the
        // Menu primitive closes from the document capture phase and calls
        // preventDefault there, before React dispatches this handler.
        if (event.key !== 'Escape' || event.defaultPrevented || confirmId !== null || selectedId === null) return
        event.preventDefault()
        event.stopPropagation()
        closeDetails()
      }}
    >
      <div className={css.listPane}>
        <div className={css.pageScroll}>
          <div className={css.pageContent}>
            <div className={css.pageHeading}>
              <h1 ref={headingRef} tabIndex={-1}>{t('title')}</h1>
              <div className={css.creationActions}>
                <Button variant="soft" size="toolbar" icon={<IconPlusOutline16 />} disabled={creating||unavailable||answer.unsupported===true}
                  onClick={createTask}>{t(creating?'new.pending':'new.action')}</Button>
              </div>
            </div>
            {(environments.showComputer||environments.choices.length>1)&&shownEnvironment!==undefined&&<div className={css.environmentRow}>
              {environments.choices.length>1?<Menu open={environmentMenu} onClose={()=>{setEnvironmentMenu(false);setEnvironmentSearch('')}}
                selectedId={environmentKey} portal
                header={<Input type="search" aria-label={t(environments.showComputer?'environment.search':'environment.searchRuntime')} placeholder={t(environments.showComputer?'environment.search':'environment.searchRuntime')}
                  value={environmentSearch} onChange={(event)=>{setEnvironmentSearch(event.target.value)}}/>}
                items={choices.length===0?[{ id:'__empty',label:t('environment.empty'),disabled:true }]:choices.map(item=>({
                  id:item.key,label:environmentLabel(item),disabled:!item.available,
                }))}
                footer={[{ id:'__refresh',label:t('environment.refresh') }]}
                onSelect={(key)=>{
                  if(key==='__refresh'){void refreshTaskEnvironments();return}
                  if(switchDisabled)return
                  const choice=environments.choices.find(item=>item.key===key)
                  if(choice===undefined||!choice.available)return
                  setChosenEnvironment(choice);setEnvironmentKey(choice.key);setEnvironmentMenu(false);setEnvironmentSearch('');setCreationFailed(false)
                }}
                anchor={<Button variant="ghost" size="toolbar" className={css.environmentTrigger}
                  disabled={switchDisabled} aria-label={t('environment.choose')} aria-haspopup="menu" aria-expanded={environmentMenu}
                  title={switchDisabled?t('environment.finishDetails'):environmentLabel(shownEnvironment)}
                  onClick={()=>{setEnvironmentMenu(open=>!open)}}>
                  <span className={css.environmentName}>{environmentLabel(shownEnvironment)}</span><IconChevronDownOutline14/>
                </Button>}/>:<ComputerBadge name={environmentLabel(shownEnvironment)} label={t('environment.label')}/>}
            </div>}
            {(unavailable||answer.unsupported===true||creationFailed)&&<p className={css.environmentNotice} role="status">
              {t(unavailable?'environment.unavailable':answer.unsupported?'environment.unsupported':'new.error')}
              {(unavailable||answer.unsupported===true)&&<Button variant="ghost" size="sm" onClick={()=>{
                if(unavailable)void refreshTaskEnvironments()
                else void onRetry()
              }}>{t('list.retry')}</Button>}
            </p>}
            <div className={css.filters}>
              <div className={css.filterTabs} role="group" aria-label={t('statusFilter.label')}>
                {(['all', 'active', 'inactive'] as const).map(value => (
                  <button
                    key={value}
                    type="button"
                    className={clsx(css.filterTab, statusFilter === value && css.filterTabActive)}
                    aria-pressed={statusFilter === value}
                    onClick={() => { setStatusFilter(value) }}
                  >
                    {t(value === 'all' ? 'statusFilter.all' : `status.${value}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className={css.searchField}>
              <Input
                type="search"
                icon={<IconSearchOutline16 />}
                aria-label={t('search.label')}
                placeholder={t('search.placeholder')}
                value={search}
                onChange={(event) => { setSearch(event.target.value) }}
              />
              {search !== '' && <Button size="sm" className={css.searchClear} aria-label={t('search.clear')} onClick={() => { setSearch('') }}>
                <IconCloseOutline16 />
              </Button>}
            </div>
            <div className={css.list}>
              {selected === undefined && !unavailable && answer.unsupported!==true
                && <CatalogFeedback status={status} populated={rows.length > 0} onRetry={onRetry} t={t} />}
              {status === 'ready' && rows.length === 0 && <div className={css.empty} role="status">
                <IconClockOutline16 size={24} className={css.emptyGlyph} />
                <h2>{t(emptyTitle)}</h2>
                <Button variant="outline" className={css.emptyAction} disabled={creating||unavailable||answer.unsupported===true} onClick={createTask}>
                  {t('empty.action')}
                </Button>
              </div>}
              <ul className={css.listRows} aria-label={t('list.label')} aria-busy={status === 'loading'}>
                {rows.map((record) => {
                  // One pair per row: the same absolute stamp and distance reach
                  // both halves, from one formatting call.
                  const nextRun = nextRunParts(record.scheduledAt, t('time.locale'), now, t)
                  return (
                    <li key={record.id}>
                      <Button
                        className={clsx(css.row, selectedId === record.id && css.selectedRow,
                          record.status === 'inactive' && css.endedRow)}
                        aria-label={taskName(record)}
                        aria-describedby={`${detailId}-metadata-${record.id}`}
                        aria-expanded={selectedId === record.id}
                        aria-controls={selectedId === record.id ? detailId : undefined}
                        onClick={(event) => {
                          rowRef.current = event.currentTarget
                          setSelectedId(record.id)
                          setTab('rule')
                        }}
                      >
                        <IconClockOutline16 className={css.rowGlyph} />
                        <span className={css.rowContent}>
                          <span className={css.rowTitle}>{taskName(record)}</span>
                          <span className={css.rowSummary} id={`${detailId}-metadata-${record.id}`}>
                            {record.status === 'inactive'
                              && <span className={css.metadata}>{t('status.inactive')}</span>}
                            <span className={css.metadata}>{frequency(record)}</span>
                            {record.status === 'active' && <span className={css.metadata}>
                              {t('list.nextPrefix')}<time dateTime={record.scheduledAt}>
                                {nextRun.absolute}
                              </time>
                              {' '}<span className={css.nextRunRelative}>{nextRun.relative}</span>
                            </span>}
                          </span>
                        </span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </div>
      </div>
      {selected !== undefined && <TaskDetail
        {...detail.props}
        task={selected}
        authoritative={catalogRecord !== undefined}
        onDeleted={closeDetails}
        onClose={closeDetails}
        available={!unavailable}
      />}
    </section>
  )
}
