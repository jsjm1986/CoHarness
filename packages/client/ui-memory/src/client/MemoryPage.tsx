/** The Memory main panel: durable entries browsed by scope and kind, with member edits where writable. */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MemoryEntry, MemoryKind, MemoryRefusalCode, MemoryScope } from '@deepseek-ai/dsh-memory/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  contentPreview, filterEntries, groupEntries, MEMORY_KINDS, scopeCaption, scopeKeyOf,
  scopeLabelKey, scopeTitle, sourceLabelKey,
} from './memory.ts'
import type { MemoryInjected } from './memory-source.ts'
import css from './MemoryPage.module.css'

/** Props the renderer binds for the Memory page. */
export type MemoryPageProps = PropsRuntime<'main'>
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

/** The editor's translate prop, narrowed to the bound namespace. */
type Translate = PropsLocale<'memory'>['t']

/**
 * Render the scope rail and the selected scope's entries grouped by kind,
 * with client-side search over key, summary, and content. Write controls
 * follow the Remote catalog's per-scope `writable` flag only.
 * @param props - framework snapshot, localized copy, and injected actions.
 * @returns the Memory page body.
 */
export function MemoryPage(props: MemoryPageProps) {
  const { t, useMemory, useSessions, useWorkspaces, select, refresh, save, remove, openSource } = props
  const snapshot = useMemory(state => state)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [editor, setEditor] = useState<Editor | undefined>(undefined)
  const [confirmKey, setConfirmKey] = useState<string | undefined>(undefined)

  const view = snapshot.scopes.find(item => scopeKeyOf(item.scope) === snapshot.selected)
  const rows = useMemo(
    () => groupEntries(filterEntries(snapshot.entries ?? [], search)),
    [snapshot.entries, search],
  )

  const openEditor = (next: Editor | undefined): void => {
    setEditor(next)
    setConfirmKey(undefined)
  }

  const rail = (
    <nav className={css.rail} aria-label={t('title')}>
      {snapshot.scopes.map((item) => {
        const key = scopeKeyOf(item.scope)
        const labelKey = scopeLabelKey(item.scope)
        const caption = scopeCaption(item.scope)
        const title = scopeTitle(item.scope)
        return (
          <button
            key={key}
            type="button"
            className={clsx(css.scopeRow, key === snapshot.selected && css.selected)}
            title={title}
            onClick={() => { select(key); openEditor(undefined) }}
          >
            <span className={css.scopeName}>
              <span>{labelKey === undefined ? caption ?? item.scope.kind : t(labelKey)}</span>
              {caption !== undefined && labelKey !== undefined
                ? <span className={css.scopeCaption}>{caption}</span>
                : null}
            </span>
            <span className={css.scopeCount}>{t('scope.entries', { count: item.entries })}</span>
            {item.writable ? null : <span className={css.readonlyTag}>{t('entry.readonly')}</span>}
          </button>
        )
      })}
    </nav>
  )

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
  } else if (rows.length === 0) {
    body = <div className={css.feedback}>{t('list.noMatches')}</div>
  } else {
    body = rows.map(section => (
      <section key={section.kind}>
        <h2 className={css.kindHeading}>{t(KIND_KEYS[section.kind])}</h2>
        {section.rows.map((entry) => {
          const key = String(entry.key)
          const open = expanded === key
          const sourceId = entry.updated.sessionId
          const link = sourceId === undefined ? 'unavailable' : sourceState(sourceId, sessions, workspaces)
          return (
            <article key={key} className={css.entry}>
              <div className={css.entryHead}>
                <span className={css.entryKey}>{key}</span>
                <span className={css.entrySummary}>{entry.summary}</span>
              </div>
              <div className={css.entryMeta}>
                <span>{t('entry.updated', { time: new Date(entry.updated.at).toLocaleString() })}</span>
                <span>{t(sourceLabelKey(entry.updated.source))}</span>
                {entry.updated.userId === undefined
                  ? null
                  : <span>{t('entry.member', { id: entry.updated.userId })}</span>}
                <span>{t('entry.revision', { revision: String(entry.revision).slice(0, 8) })}</span>
              </div>
              {open
                ? <pre className={css.entryContent}>{entry.content}</pre>
                : <p className={css.entryPreview}>{contentPreview(entry.content)}</p>}
              <div className={css.entryActions}>
                <button type="button" className={css.linkButton} onClick={() => { setExpanded(open ? undefined : key) }}>
                  {open ? '−' : '+'}
                </button>
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
                        <span>{t('editor.confirmDelete')}</span>
                        <button
                          type="button"
                          className={css.linkButton}
                          onClick={() => {
                            void remove({ scope: entry.scope, key, expectedRevision: entry.revision })
                              .then(() => { setConfirmKey(undefined) })
                          }}
                        >
                          {t('editor.confirmAction')}
                        </button>
                      </>
                    ) : (
                      <button type="button" className={css.linkButton} onClick={() => { setConfirmKey(key) }}>
                        {t('editor.delete')}
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            </article>
          )
        })}
      </section>
    ))
  }

  return (
    <div className={css.page}>
      {rail}
      <div className={css.listPane}>
        <div className={css.pageScroll}>
          <div className={css.pageContent}>
            <div className={css.pageHeading}>
              <h1>{t('title')}</h1>
            </div>
            <p className={css.pageDescription}>{t('description')}</p>
            {snapshot.enabled ? null : <div className={css.notice}>{t('disabled.notice')}</div>}
            <div className={css.toolbar}>
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
            {body}
          </div>
        </div>
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
      <h2 className={css.kindHeading}>{t(editing === undefined ? 'editor.create' : 'editor.edit')}</h2>
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
