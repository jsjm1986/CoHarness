/** Account requests shared by the visible activity bodies of one Session. */
import type { SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityInjected } from './ActivityBody.tsx'
import { ActivityRequestError, fetchActivity, fetchProgress, generateProgress } from './feed.ts'
import type { ActivityStore } from './store.ts'

const POLL_INTERVAL_MS = 2_500
const POLL_ROUNDS = 48

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('Activity polling aborted', { cause: reason }))
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, POLL_INTERVAL_MS)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function accessLost(error: unknown): boolean {
  return error instanceof ActivityRequestError && (error.status === 401 || error.status === 403)
}

/**
 * Start requests while a body is visible and suppress results after supersession or detachment.
 * @param target - the Session's Runtime, or undefined to use the standalone account route.
 * @param actions - this Session's activity store writers.
 * @param lifetime - the registering plugin's lifetime.
 * @param track - retain admitted requests until disposal can join them.
 * @returns view attachment, refresh, pagination and digest submission callbacks.
 */
export function activityRequests(target: SessionRuntimeTarget | undefined, actions: PropsStore<ActivityStore>['actions'],
  lifetime: AbortSignal, track: (task: Promise<void>) => void): Omit<ActivityInjected, 'reveal'> {
  const bodies = new Set<() => void>()
  let visible: AbortController | undefined
  let feedRead: AbortController | undefined
  let journalRead: { controller: AbortController; posting: boolean; watching: boolean } | undefined

  const load = (before: string | undefined, member: number | null): void => {
    if (visible === undefined) return
    feedRead?.abort()
    feedRead = new AbortController()
    const signal = AbortSignal.any([visible.signal, feedRead.signal])
    track((async () => {
      actions.loading()
      try {
        const page = await fetchActivity(before, signal, target, member)
        if (signal.aborted) return
        if (before === undefined) actions.refreshed(page)
        else actions.appended(page)
      } catch (error) {
        if (!signal.aborted) actions.failed(accessLost(error))
      }
    })())
  }

  const readJournal = (submit: boolean): void => {
    if (visible === undefined || journalRead?.posting || (submit && journalRead?.watching)) return
    journalRead?.controller.abort()
    const request = { controller: new AbortController(), posting: submit, watching: false }
    journalRead = request
    const cancelled = AbortSignal.any([visible.signal, request.controller.signal])
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(POLL_ROUNDS * POLL_INTERVAL_MS)])
    track((async () => {
      try {
        if (submit) {
          actions.progressTracking('submitting')
          const result = await generateProgress(target, signal)
          signal.throwIfAborted()
          if (!result.started && result.reason === 'unavailable') {
            actions.progressFailed('generate-unavailable', false)
            return
          }
          request.posting = false
          request.watching = true
          actions.progressTracking('watching')
        }
        for (let round = 0; round <= POLL_ROUNDS; round += 1) {
          signal.throwIfAborted()
          const page = await fetchProgress(signal, target)
          signal.throwIfAborted()
          request.watching = page.status.generating
          actions.progressLoaded(page)
          if (!request.watching || cancelled.aborted) return
          if (round < POLL_ROUNDS) await waitForPoll(signal)
        }
        actions.progressFailed('status-unknown', false)
      } catch (error) {
        if (cancelled.aborted) return
        const discard = accessLost(error)
        actions.progressFailed(!discard && (submit || request.watching) ? 'status-unknown' : 'load-failed', discard)
      } finally {
        if (journalRead === request) journalRead = undefined
      }
    })())
  }

  const refresh = (member: number | null): void => { load(undefined, member); readJournal(false) }

  return {
    attach: (bodySignal, member) => {
      const signal = AbortSignal.any([bodySignal, lifetime])
      if (signal.aborted) return () => {}
      const first = visible === undefined
      visible ??= new AbortController()
      const release = (): void => {
        signal.removeEventListener('abort', release)
        if (!bodies.delete(release) || bodies.size > 0) return
        const closing = visible
        visible = undefined
        journalRead = undefined
        closing?.abort()
      }
      bodies.add(release)
      signal.addEventListener('abort', release, { once: true })
      if (first) refresh(member)
      return release
    },
    refresh,
    filter: (member) => {
      if (visible === undefined) return
      actions.filtered(member)
      load(undefined, member)
    },
    loadMore: load,
    generate: () => { readJournal(true) },
  }
}
