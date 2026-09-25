/** Session-owned delivery cards, historical comparisons, and current-file references. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { changesReviewAddress } from '../changes.ts'
import { ChangesDiffStore } from './changes-diff.ts'
import { ChangesSummaryStore } from './changes-summary.ts'
import { PresentedOpenController } from './present-open.ts'
import { PresentRow } from './PresentRow.tsx'
import { DeliverablesTail, selectDeliverables, type DeliverablesInjected } from './Deliverables.tsx'
import { ReviewTab, type ReviewInjected } from './ReviewTab.tsx'
import { CHANGES_REVIEW_ID, changesReviewDefinition } from './review-definition.ts'
import { createReviewStore } from './review-store.ts'
import { ProducedFiles } from './ProducedFiles.tsx'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import {
  deliverablesDefinition, producedFileMentions, selectProducedFiles, presentedForClosing, changesForClosing,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Produced-files row copy. */
    'deliverables': DeliverablesKey
  }
}

export { ProducedFiles, type ProducedFilesProps } from './ProducedFiles.tsx'
export { producedForClosing } from './turn-deliverables.ts'

/** Required services for the tail-slot registration and its dictionaries. */
export const inject = ['slots', 'locale', 'conversationEvents', 'connection', 'sessions', 'sidebarRightTabs', 'sidebarRight']

/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.conversationEvents.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: owner => changesForClosing(owner) === null && presentedForClosing(owner).length === 0 ? selectProducedFiles(owner) : null,
      locale: NS,
      inject: () => ({
        isLoopback: connection.isLoopback,
        hooks: { hostDescription: connection.hostDescription },
      }),
    }, ProducedFiles),
  )
  // The prose side of the same vocabulary: the chat view reaches this face
  // via ctx.get, so its absence — this plugin composed out — is the off state.
  const resources = new Map<SessionId, { summaries: ChangesSummaryStore; diffs: ChangesDiffStore; opener: PresentedOpenController }>()
  const forSession = (sessionId: SessionId) => {
    const found = resources.get(sessionId)
    if (found !== undefined) return found
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) throw new Error('Workspace review requires a retained Session')
    const target = ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const }
    const transport = target.kind === 'base' ? connection : connection.forTarget?.(target)
    if (transport === undefined) throw new Error('Workspace review runtime is unavailable')
    const fetchRecord = async (url: string, signal: AbortSignal): Promise<Response> => {
      const parsed = new URL(url, 'https://workspace.invalid')
      if (parsed.searchParams.get('sessionId') !== sessionId) throw new Error('Review request belongs to another Session')
      const seq = Number(parsed.searchParams.get('seq'))
      const response = parsed.pathname === '/api/changes.summary'
        ? await transport.api.workspaceChanges.summary({ sessionId, seq }, signal)
        : await transport.api.workspaceChanges.diff({ sessionId, seq, index: Number(parsed.searchParams.get('index')) }, signal)
      if (!response.result.ok) {
        return new Response(null, { status: 403 })
      } else {
        return response.result.value === null ? new Response(null, { status: 404 }) : Response.json(response.result.value)
      }
    }
    const summaries = new ChangesSummaryStore(fetchRecord)
    const diffs = new ChangesDiffStore(fetchRecord)
    const desktop = () => {
      const description = transport.hostDescription.getSnapshot()
      return { name: '', available: target.kind === 'base' && transport.isLoopback
        && description?.executionAuthorityRequired === false && description.canOpenPath,
      fileManager: 'directory' as const }
    }
    const opener = new PresentedOpenController(desktop, async (path, action, signal) => {
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      if (cwd === undefined) throw new Error('Session workspace is unavailable')
      const absolute = resolveWorkspacePath(cwd, path)
      const parent = absolute.replace(/[^\\/]+$/u, '')
      const result = await transport.api.host.openPath({ path: action === 'reveal' ? parent : absolute }, signal)
      if (!result.result.ok) throw new Error(result.result.error.code)
    })
    scope.effect(() => transport.hostDescription.subscribe(() => { opener.resetHost() }), 'ui-deliverables: desktop capability')
    const owned = { summaries, diffs, opener }
    resources.set(sessionId, owned)
    scope.effect(() => async () => {
      if (resources.get(sessionId) === owned) resources.delete(sessionId)
      await Promise.all([summaries.dispose(), diffs.dispose(), opener.dispose()])
    }, 'ui-deliverables: authorized Session reads')
    return owned
  }
  ctx.effect(() => async () => {
    await Promise.all([...resources.values()].flatMap(({ summaries, diffs, opener }) =>
      [summaries.dispose(), diffs.dispose(), opener.dispose()]))
    resources.clear()
  }, 'ui-deliverables: readers')
  ctx.on('connection/reset', () => {
    for (const { summaries, diffs, opener } of resources.values()) {
      summaries.reset(); diffs.reset(); opener.resetHost()
    }
  })
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', select: selectDeliverables, locale: NS,
    inject: (sessionId): DeliverablesInjected => {
      const { summaries, opener } = forSession(sessionId)
      return {
        hooks: { presentedOpen: opener.state, presentedHost: opener.host, changesSummary: summaries.state },
        reloadPresentedHost: () => opener.loadHost(),
        loadChangesSummary: (id, seq) => summaries.load(id, seq),
        openPresented: (id, seq, index, action, path) => opener.open(id, seq, index, action, path),
        openChanged: (id, seq, index, path) => opener.openChanged(id, seq, index, path),
        openChangesReview: (coordinates, index) => {
          if (coordinates.sessionId !== sessionId) throw new Error('Review navigation belongs to another Session')
          ctx.sidebarRight.openSessionResource(sessionId, changesReviewAddress(coordinates), { params: { index } })
        },
      }
    },
  }, DeliverablesTail))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow))
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(changesReviewDefinition(t)), 'ui-deliverables: review type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CHANGES_REVIEW_ID, locale: NS, store: createReviewStore(),
    inject: (sessionId): ReviewInjected => {
      const { summaries, diffs, opener } = forSession(sessionId)
      return {
        hooks: { changesSummary: summaries.state, changesDiff: diffs.state, presentedOpen: opener.state, presentedHost: opener.host },
        loadChangesSummary: (id, seq) => summaries.load(id, seq),
        loadChangesDiff: (id, seq, index) => diffs.load(id, seq, index),
        reloadPresentedHost: () => opener.loadHost(),
        openChanged: (id, seq, index, path) => opener.openChanged(id, seq, index, path),
      }
    },
  }, ReviewTab))
  const mentions: ChatFileMentions = {
    forClosing(owner) {
      // Same claim test the turn-tail chain entry runs: no produced files,
      // no vocabulary — the two surfaces agree by construction.
      const paths = selectProducedFiles(owner)
      const presented = presentedForClosing(owner)
      if (paths === null && presented.length === 0) return undefined
      return producedFileMentions([...new Set([...paths ?? [], ...presented.map(file => file.path)])], owner.openFile, path => t('produced.open', { name: path }))
    },
  }
  ctx.provide('chatFileMentions', mentions)
}
