/** The Memory right-Sidebar tab: durable entries on a day-grouped timeline, scoped to the Session's context. */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MemoryAttribution, MemoryEntry, MemoryKind, MemoryRefusalCode, MemoryScope } from '@deepseek-ai/dsh-memory/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  filterEntries, groupEntriesByDay, MEMORY_KINDS, scopeCaption, scopeKeyOf,
  scopeLabelKey, sourceLabelKey,
} from './memory.ts'
import type { MemoryInjected } from './memory-source.ts'
import css from './MemoryTab.module.css'

/** Props the renderer binds for the Memory tab body. */
export type MemoryTabProps = PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<MemoryInjected>
  & PropsLocale<'memory'>

/** Editor session: creating under `scope`, or editing `entry` with its revision fenced. */
type Editor =
  | { readonly mode: 'create'; readonly scope: MemoryScope }
  | { readonly mode: 'edit'; readonly entry: MemoryEntry }

/** Whether the linked source Session can be opened, or why the link is inert. */
function sourceState(
  id: SessionId, sessions: SessionListState, workspaces: WorkspaceListState,
): 'available' | 'loading' | 'unavailable' {
  if (workspaces.state === 'error') return 'unavailable'
  if (sessions.phase === 'pending' || workspaces.phase === 'pending') return 'loading'
  if (sessions.archivedById[id] !== undefined || workspaces.archivedSessionIds.includes(id)) return 'unavailable'
  return sessions.ids.includes(id) ? 'available' : 'unavailable'
}

const REFUSAL_KEYS: Record<MemoryRefusalCode, `refusal.${MemoryRefusalCode}`> = {
  memory_exists: 'refusal.memory_exists',
  memory_not_found: 'refusal.memory_not_found',
  memory_stale: 'refusal.memory_stale',
  memory_full: 'refusal.memory_full',
  memory_invalid: 'refusal.memory_invalid',
}

const KIND_KEYS: Record<MemoryKind, `kind.${MemoryKind}`> = {
  profile: 'kind.profile',
  guidance: 'kind.guidance',
  background: 'kind.background',
  resource: 'kind.resource',
}

const SOURCE_CLASS: Record<MemoryAttribution['source'], string | undefined> = {
  agent: css.srcAgent,
  extraction: css.srcExtraction,
  consolidation: css.srcConsolidation,
  member: css.srcMember,
}

const KIND_CLASS: Record<MemoryKind, string | undefined> = {
  profile: css.kProfile,
  guidance: css.kGuidance,
  background: css.kBackground,
  resource: css.kResource,
}

/** The editor's translate prop, narrowed to the bound namespace. */
type Translate = PropsLocale<'memory'>['t']

/** The local `YYYY-MM-DD` of `now`, for the today label. */
function todayKey(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Short `HH:mm` for one timeline row's stamp. */
function timeOf(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Render the scope switcher and the selected scope's day-grouped timeline.
 * The catalog itself is space-filtered by the Host, so the switcher only
 * appears while more than one scope is offered; write controls follow the
 * Remote catalog's per-scope `writable` flag only.
 * @param props - framework snapshot, localized copy, and injected actions.
 * @returns the Memory tab body.
 */
export function MemoryTab(props: MemoryTabProps) {
  const { t, useMemory, useSessions, useWorkspaces, select, refresh, save, remove, openSource } = props
  const snapshot = useMemory(state => state)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [editor, setEditor] = useState<Editor | undefined>(undefined)
  const [confirmKey, setConfirmKey] = useState<string | undefined>(undefined)

  const view = snapshot.scopes.find(item => scopeKeyOf(item.scope) === snapshot.selected)
  const sections = useMemo(
    () => groupEntriesByDay(filterEntries(snapshot.entries ?? [], search)),
    [snapshot.entries, search],
  )
  const today = todayKey(new Date())

  const openEditor = (next: Editor | undefined): void => {
    setEditor(next)
    setConfirmKey(undefined)
  }

  const scopeName = (item: (typeof snapshot.scopes)[number]): string => {
    const labelKey = scopeLabelKey(item.scope)
    if (labelKey !== undefined) return t(labelKey)
    const caption = scopeCaption(item.scope)
    return caption === undefined ? item.scope.kind : `${t('scope.workspace')} · ${caption}`
  }

  let body: ReactNode
  if (editor !== undefined && view?.writable === true) {
    body = (
      <MemoryEditor
        editor={editor}
        t={t}
        onSave={save}
        onDelete={remove}
        onClose={() => { openEditor(undefined) }}
      />
    )
  } else if (snapshot.status === 'loading' && !snapshot.settled) {
    body = <div className={css.feedback}>{t('list.loading')}</div>
  } else if (snapshot.status === 'error' || snapshot.entriesFailed) {
    body = <div className={css.feedback}>{t('list.failed')}</div>
  } else if (snapshot.entries === undefined) {
    body = <div className={css.feedback}>{t('list.loading')}</div>
  } else if (snapshot.entries.length === 0) {
    body = <div className={css.feedback}>{t('list.empty')}</div>
  } else if (sections.length === 0) {
    body = <div className={css.feedback}>{t('list.noMatches')}</div>
  } else {
    body = (
      <div className={css.feed}>
        {sections.map(section => (
          <section key={section.day} className={css.daySection}>
            <h2 className={css.dayLabel}>{section.day === today ? t('day.today') : section.day}</h2>
            {section.rows.map((entry) => {
              const key = String(entry.key)
              const open = expanded === key
              const sourceId = entry.updated.sessionId
              const link = sourceId === undefined ? 'unavailable' : sourceState(sourceId, sessions, workspaces)
              const srcClass = SOURCE_CLASS[entry.updated.source]
              return (
                <article
                  key={key}
                  className={clsx(css.item, open && css.open)}
                  onClick={() => { setExpanded(open ? undefined : key) }}
                >
                  <span className={clsx(css.dot, srcClass)} aria-hidden />
                  <div className={css.itemBody}>
                    <div className={css.itemHead}>
                      <span className={css.entryKey}>{key}</span>
                      <span className={css.time}>{timeOf(entry.updated.at)}</span>
                    </div>
                    <p className={css.summary}>{entry.summary}</p>
                    <div className={css.tags}>
                      <span className={clsx(css.kbadge, KIND_CLASS[entry.kind])}>{t(KIND_KEYS[entry.kind])}</span>
                      <span className={css.srcLabel}>{t(sourceLabelKey(entry.updated.source))}</span>
                      {entry.updated.userId === undefined
                        ? null
                        : <span className={css.srcLabel}>{t('entry.member', { id: entry.updated.userId })}</span>}
                    </div>
                    {open ? (
                      <div className={css.meta}>
                        {`${t('entry.updated', { time: new Date(entry.updated.at).toLocaleString() })} · ${t('entry.revision', { revision: String(entry.revision).slice(0, 8) })}`}
                      </div>
                    ) : null}
                    {open ? <pre className={css.detail}>{entry.content}</pre> : null}
                    {open ? (
                      <div className={css.actions} onClick={(event) => { event.stopPropagation() }}>
                        {sourceId === undefined ? null : (
                          <button
                            type="button"
                            className={css.linkButton}
                            disabled={link !== 'available'}
                            onClick={() => { openSource(sourceId) }}
                          >
                            {t('entry.openSession')}
                          </button>
                        )}
                        {view?.writable === true ? (
                          <>
                            <button type="button" className={css.linkButton} onClick={() => { openEditor({ mode: 'edit', entry }) }}>
                              {t('editor.edit')}
                            </button>
                            {confirmKey === key ? (
                              <>
                                <span className={css.confirmText}>{t('editor.confirmDelete')}</span>
                                <button
                                  type="button"
                                  className={clsx(css.linkButton, css.danger)}
                                  onClick={() => {
                                    void remove({ scope: entry.scope, key, expectedRevision: entry.revision })
                                      .then(() => { setConfirmKey(undefined) })
                                  }}
                                >
                                  {t('editor.confirmAction')}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className={clsx(css.linkButton, css.danger)}
                                onClick={() => { setConfirmKey(key) }}
                              >
                                {t('editor.delete')}
                              </button>
                            )}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </section>
        ))}
      </div>
    )
  }

  return (
    <div className={css.tab}>
      <div className={css.toolbar}>
        {snapshot.scopes.length > 1 ? (
          <select
            className={css.scopeSelect}
            aria-label={t('scope.switch')}
            value={snapshot.selected}
            onChange={(event) => { select(event.target.value); openEditor(undefined) }}
          >
            {snapshot.scopes.map(item => (
              <option key={scopeKeyOf(item.scope)} value={scopeKeyOf(item.scope)}>
                {`${scopeName(item)} · ${t('scope.entries', { count: item.entries })}`}
              </option>
            ))}
          </select>
        ) : view === undefined ? null : (
          <span className={css.scopeStatic}>{scopeName(view)}</span>
        )}
        <Input
          className={clsx(css.search)}
          value={search}
          placeholder={t('search.placeholder')}
          icon={<IconSearchOutline16 />}
          onChange={(event) => { setSearch(event.target.value) }}
        />
        <Button variant="toolbar" aria-label={t('toolbar.refresh')} onClick={() => { refresh() }}>
          <IconRefreshOutline16 />
        </Button>
        {view?.writable === true ? (
          <Button variant="toolbar" aria-label={t('new.action')} onClick={() => { openEditor({ mode: 'create', scope: view.scope }) }}>
            <IconPlusOutline16 />
          </Button>
        ) : null}
      </div>
      {snapshot.enabled ? null : <div className={css.notice}>{t('disabled.notice')}</div>}
      <div className={css.scroll}>{body}</div>
      <div className={css.footer}>
        <span>{view === undefined ? '' : scopeName(view)}</span>
        {view?.writable === false ? <span>{t('entry.readonly')}</span> : null}
      </div>
    </div>
  )
}

/**
 * Render the create/edit form. Keys lock after creation; the revision of
 * the edited entry fences both save and delete against concurrent writes.
 * @param props - the editor session, copy, and write callbacks.
 * @returns the editor form.
 */
function MemoryEditor({ editor, t, onSave, onDelete, onClose }: {
  readonly editor: Editor
  readonly t: Translate
  readonly onSave: MemoryInjected['save']
  readonly onDelete: MemoryInjected['remove']
  readonly onClose: () => void
}) {
  const editing = editor.mode === 'edit' ? editor.entry : undefined
  const scope = editor.mode === 'create' ? editor.scope : editor.entry.scope
  const [kind, setKind] = useState<MemoryKind>(editing?.kind ?? 'guidance')
  const [key, setKey] = useState(editing === undefined ? '' : String(editing.key))
  const [summary, setSummary] = useState(editing?.summary ?? '')
  const [content, setContent] = useState(editing?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    setSaving(true)
    setFailure(undefined)
    const request = {
      scope,
      key,
      kind,
      summary,
      content,
      ...(editing === undefined ? {} : { expectedRevision: editing.revision }),
    }
    try {
      const result = await onSave(request)
      if (!result.ok) { setFailure(t('editor.failed')); return }
      const write = result.value
      if (write.ok) { onClose(); return }
      setFailure(t(REFUSAL_KEYS[write.code]))
    } catch {
      setFailure(t('editor.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.editor}>
      <h2 className={css.editorHeading}>{t(editing === undefined ? 'editor.create' : 'editor.edit')}</h2>
      <div className={css.editorField}>
        <span className={css.editorLabel}>{t('editor.kind')}</span>
        <select value={kind} disabled={saving} onChange={(event) => { setKind(event.target.value as MemoryKind) }}>
          {MEMORY_KINDS.map(option => <option key={option} value={option}>{t(KIND_KEYS[option])}</option>)}
        </select>
      </div>
      <div className={css.editorField}>
        <span className={css.editorLabel}>{t('editor.key')}</span>
        <Input value={key} disabled={saving || editing !== undefined} onChange={(event) => { setKey(event.target.value) }} />
        <span className={css.editorHint}>{t('editor.keyHint')}</span>
      </div>
      <div className={css.editorField}>
        <span className={css.editorLabel}>{t('editor.summary')}</span>
        <Input value={summary} disabled={saving} onChange={(event) => { setSummary(event.target.value) }} />
        <span className={css.editorHint}>{t('editor.summaryHint')}</span>
      </div>
      <div className={css.editorField}>
        <span className={css.editorLabel}>{t('editor.content')}</span>
        <textarea className={css.contentArea} value={content} disabled={saving} onChange={(event) => { setContent(event.target.value) }} />
      </div>
      {failure === undefined ? null : <span className={css.editorError}>{failure}</span>}
      <div className={css.editorActions}>
        <Button variant="primary" disabled={saving} onClick={() => { void submit() }}>
          {saving ? t('editor.saving') : t('editor.save')}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onClose}>{t('editor.cancel')}</Button>
        <span className={css.spacer} />
        {editing === undefined ? null : (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              void onDelete({ scope: editing.scope, key: String(editing.key), expectedRevision: editing.revision })
                .then(() => { onClose() })
            }}
          >
            {t('editor.delete')}
          </Button>
        )}
      </div>
    </div>
  )
}
