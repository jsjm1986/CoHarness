/**
 * Skill discovery and source previews for the addressed session's runtime.
 * A pick inserts literal `/name ` text; `dsh-tool-skill` owns recognition
 * and instruction injection, including user-only skills. The source has no
 * adjudication hook or reference codec; its lexicon supplies draft decoration.
 *
 * Catalog fetches are shared per session and prewarmed when its scope opens.
 * A preset switch invalidates that session; connection/reset invalidates all.
 * Shared discovery outlives one menu interaction; invalidation or disposal
 * aborts it. Source previews own separate reads cancelled on close or replacement.
 *
 * The `skill` tool row reads only the durable call/result slice, independently
 * of the current catalog or source preview.
 */
// Type-only: the carrier types, the forwarded Host-event face and the ctx.remote merge.
import type { ConnectionHandle, SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SkillRow } from './SkillRow.tsx'
import { SkillPreview, type SkillPreviewInjected } from './SkillPreview.tsx'
import { en, NS, zh, type SkillKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated skill tool row's copy. */
    skill: SkillKey
  }
}

/** One session's catalog fetch: the shared promise plus its own abort handle. */
interface CatalogFetch {
  readonly promise: Promise<readonly SkillEntry[]>
  readonly abort: AbortController
  /** Settled catalog for synchronous lexicon reads (unset while in flight or on failure). */
  settled?: readonly SkillEntry[]
}

/** Required services: reference source faces plus the tool-row and locale registries. */
export const inject = ['inputTriggers', 'connection', 'sessions', 'slots', 'locale', 'remote']

/**
 * Client plugin body: register the '/' source, dictionaries, and keyed tool row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skill: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'skill', locale: NS },
    SkillRow,
  ))

  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = ctx.get('sessions') as ISessions
  const apiFor = (sessionId: SessionId): ConnectionHandle['api'] => {
    if (connection.forSession !== undefined) return connection.forSession(sessionId).api
    const target = sessions.runtimeTargetFor?.(sessionId)
    if (target === undefined) return connection.api
    const scoped = connection.forTarget?.(target)
    if (scoped === undefined) throw new Error('The session runtime connection is unavailable')
    return scoped.api
  }
  ctx.slots.inject('conversation.chat.skill-preview', () => ctx.slots.register({
    name: 'conversation.chat.skill-preview',
    locale: NS,
    inject: (sessionId: SessionId): SkillPreviewInjected => ({
      async loadSkill(name, signal) {
        signal.throwIfAborted()
        if (sessions.subagentAddress(sessionId) !== undefined) return undefined
        const { result } = await apiFor(sessionId).skills.get({ sessionId, name }, signal)
        if (!result.ok) throw new Error(`skill.get failed: ${result.error.code}: ${result.error.message}`)
        return result.value.skill
      },
    }),
  }, SkillPreview))
  // Session-keyed catalog cache; single-flight per key. Plugin-closure state:
  // the fiber effect below is its teardown boundary.
  const fetches = new Map<SessionId, CatalogFetch>()
  // Per-session lexicon invalidation listeners (subscribeLexicon consumers).
  const lexiconListeners = new Map<SessionId, Set<() => void>>()

  const notifyLexicon = (sessionId: SessionId): void => {
    for (const listener of [...(lexiconListeners.get(sessionId) ?? [])]) {
      try {
        listener()
      } catch (error) {
        // Contain listener failures: settlement notifies from an ignored
        // promise chain (a throw would surface as an unhandled rejection)
        // and one faulty consumer must not starve the others.
        console.error('[ui-skill] lexicon listener failed:', error)
      }
    }
  }

  const fetchCatalog = (sessionId: SessionId): Promise<readonly SkillEntry[]> => {
    if (sessions.subagentAddress(sessionId) !== undefined) return Promise.resolve([])
    const existing = fetches.get(sessionId)
    if (existing !== undefined) return existing.promise
    const abort = new AbortController()
    const promise = (async () => {
      const { result } = await apiFor(sessionId).skills.list({ sessionId }, abort.signal)
      if (!result.ok) throw new Error(`skill.list failed: ${result.error.code}: ${result.error.message}`)
      return result.value.skills
    })()
    const entry: CatalogFetch = { promise, abort }
    fetches.set(sessionId, entry)
    promise.then(
      // Settled snapshot backs the synchronous lexicon reads.
      (skills) => {
        entry.settled = skills
        notifyLexicon(sessionId)
      },
      // A failed fetch must not poison the key: the next consumer retries.
      () => {
        if (fetches.get(sessionId) === entry) fetches.delete(sessionId)
      },
    )
    return promise
  }

  const invalidate = (key: SessionId): void => {
    const entry = fetches.get(key)
    if (entry === undefined) return
    fetches.delete(key)
    entry.abort.abort()
    notifyLexicon(key)
  }

  const clearAll = (): void => {
    for (const key of [...fetches.keys()]) invalidate(key)
  }

  // The bound translate resolves against the registered dictionaries with the
  // locale service's own fallback ladder; candidate-time reads stay plain text.
  const t = ctx.locale.bind(NS)

  const source: InputTriggerSource = {
    trigger: '/',
    name: 'skill',
    order: 2,
    async candidates(session, { query, signal }) {
      const skills = await fetchCatalog(session.sessionId)
      // Superseded keystroke: the shared fetch stays warm, this caller yields.
      if (signal.aborted) return []
      // The same ranking as the command group of this menu: case-insensitive
      // ordered subsequence, prefix hits first.
      return rankByName(skills, query)
        .map(skill => ({
          name: skill.name,
          // The user-only marker rides the description (the menu's only
          // secondary text); `hint` is the claim-state ghost text, not a badge.
          description: skill.modelInvocable ? skill.description : `${t('menu.userOnly')} · ${skill.description}`,
        }))
    },
    warm(session) {
      // Fire-and-forget scope-birth prewarm; the shared fetch reports
      // through candidates.
      fetchCatalog(session.sessionId).catch(() => {})
    },
    lexicon(session) {
      return fetches.get(session.sessionId)?.settled?.map(skill => skill.name)
    },
    subscribeLexicon(session, listener) {
      const key = session.sessionId
      const listeners = lexiconListeners.get(key) ?? new Set()
      listeners.add(listener)
      lexiconListeners.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) lexiconListeners.delete(key)
      }
    },
    onPick({ candidate }) {
      return { text: `/${candidate.name} ` }
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  // A preset decides which skill providers an agent reads, so a switched
  // session's cached catalog belongs to the composition it no longer runs.
  ctx.remote.$on('agent-preset/selected', invalidate)
  ctx.on('connection/reset', clearAll)
  ctx.effect(() => {
    const unregister = inputTriggers.registerSource(source)
    return () => {
      unregister()
      clearAll()
    }
  }, 'ui-skill: source')
}
