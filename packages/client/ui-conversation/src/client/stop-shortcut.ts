/** Fixed Escape routing into the current Conversation turn's scoped cancellation. */
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import { StopSequence } from './stop-sequence.ts'

/**
 * Subscribe fixed input to the same Session cancellation used by the stop button.
 * @param shortcuts - window keyboard arbitration and validated sequence interval.
 * @param sessions - live Session identities, list snapshots, and lifecycle sources.
 * @param cancel - scoped stop operation that preserves Queue and reports failures.
 * @returns disposer releasing the input subscription, pending watches and expiry timer.
 */
export function installStopShortcut(
  shortcuts: Shortcuts,
  sessions: ISessions,
  cancel: (sessionId: SessionId) => void,
): () => void {
  let unwatch = (): void => {}
  const sequence = new StopSequence(shortcuts.stopSequenceMs, () => {
    unwatch()
    unwatch = () => {}
  })
  const reset = (): void => { sequence.reset() }
  const off = shortcuts.observeFixedInput((input) => {
    if (input.type === 'reset') { reset(); return }
    const { gesture, context } = input
    if (gesture.code !== 'Escape' || gesture.repeat || gesture.composing || gesture.defaultPrevented
      || gesture.control || gesture.alt || gesture.shift || gesture.meta || context.modal !== null
      || context.region === 'terminal' || context.target === null) { reset(); return }
    const target = context.target
    const occurrence = target.closest<HTMLElement>('[data-conversation-session]')
    const region = target.closest('[data-conversation-region]')
    if (occurrence === null || region === null || !occurrence.contains(region)
      || target.closest('[data-approval-key], iframe, .xterm, [inert]') !== null) { reset(); return }
    const sessionId = occurrence.dataset.conversationSession as SessionId
    const binding = sessions.binding(sessionId)
    if (binding === undefined) { reset(); return }
    const currentTurn = (): number | undefined => {
      const session = binding.session.getSnapshot()
      if (!session.running || session.removed
        || (session.subagent !== null && session.subagent.address.mode !== 'continuable')
        || sessions.list.getSnapshot().byId[sessionId]?.pendingInteraction !== undefined) return undefined
      return session.openTurn
    }
    const turn = currentTurn()
    if (turn === undefined) { reset(); return }
    input.consume()
    const stopped = sequence.press({ sessionId, turn, generation: binding, region, cancel: () => { cancel(sessionId) } })
    if (stopped) return
    const changed = (): void => {
      if (sessions.binding(sessionId) !== binding || currentTurn() !== turn) reset()
    }
    const disposers = [binding.session.subscribe(changed), sessions.list.subscribe(changed)]
    unwatch = () => { for (const dispose of disposers) dispose() }
  })
  return () => { off(); reset() }
}
