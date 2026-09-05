import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'subagent-durability-failure'
export const inject = ['agents', 'sessionPersistence', 'subagents']

/**
 * The authored parent transcript names the background child by a stable
 * placeholder id, but the live continuable child is minted with a fresh random
 * session id at run time. This snapshot-only overlay bridges that gap and forces
 * deterministic ordering plus authored child durability failures:
 *
 *  - `PLACEHOLDER_CHILD_ID` in a scripted `send_message` is remapped to the real
 *    child so both messages reach the same live Agent.
 *  - `send_message` is Steer: an absent or idle target opens a turn, a running
 *    target claims the message at its next step boundary. The parent's first
 *    `send_message` waits for the child's first Activation to settle so it
 *    cold-resumes the child into its second turn; the second `send_message`
 *    arrives while that turn is fenced, so the child claims it as a later step
 *    of the same turn.
 *  - The unknown-id `send_message` (`UNKNOWN_CHILD_ID`) resolves through a
 *    persistence load fenced behind both accepted messages, so the transcript
 *    records the same order on every runner.
 *  - The durability checkpoint that follows the child's claim of its third
 *    message fails with a fixed message, so the scenario proves child-first
 *    disposal survives a failed last flush.
 *  - Under `DSH_SUBAGENT_PUBLISHED_FAILURE`, a one-shot child's first
 *    follow-up fails after publication, so its model prompt never runs; its
 *    published handle then also fails disposal, so the parent observes both
 *    independent failures.
 */
const PLACEHOLDER_CHILD_ID = '33333333-3333-4333-8333-333333333333'
const UNKNOWN_CHILD_ID = '22222222-2222-4222-8222-222222222222'
/** Child inbox messages accepted before the unknown-id lookup may run. */
const CHILD_MESSAGES = 3
/** The parent step whose `send_message` must open the child's second turn. */
const FIRST_SEND_MESSAGE_STEP = 2

/** Fail the child checkpoint and stabilize the authored follow-up failure ordering. */
export function apply(ctx: Context): void {
  const followupsAccepted = Promise.withResolvers<undefined>()
  const parentTurnClosed = Promise.withResolvers<undefined>()
  const childSettledOnce = Promise.withResolvers<undefined>()
  let parentClosed = false
  const publishedFailure = process.env.DSH_SUBAGENT_PUBLISHED_FAILURE === '1'
  const persistence = ctx.sessionPersistence
  const load = persistence.load.bind(persistence)
  const agents = ctx.agents
  const create = agents.create.bind(agents)

  agents.create = async (options) => {
    const handle = await create(options)
    if (!publishedFailure || options.meta?.parentSession === undefined) return handle
    handle.agent.followup = () => {
      throw new Error('snapshot published run failed')
    }
    return {
      ...handle,
      async dispose() {
        await handle.dispose()
        throw new Error('snapshot published handle disposal failed')
      },
    }
  }

  // The unavailable-child lookup is real asynchronous I/O. Fence it behind both
  // authored follow-ups so runner speed cannot reorder the exact log.
  persistence.load = async (id) => {
    if (id === UNKNOWN_CHILD_ID) await followupsAccepted.promise
    return load.call(persistence, id)
  }
  ctx.effect(() => () => {
    agents.create = create
    persistence.load = load
    followupsAccepted.resolve(undefined)
    parentTurnClosed.resolve(undefined)
    childSettledOnce.resolve(undefined)
  }, 'subagent snapshot ordering')

  // The manager's settlement notices race whatever the parent is doing when the
  // child's Activation ends. The child's first Activation settles as soon as its
  // unfenced first turn closes, and this transcript pins that "finished" notice
  // as a steered message inside the parent's spawn turn: the parent's first
  // send_message waits until the notice sits in its inbox, so the next step
  // claims it. The final "failed" notice is pinned as the parent's own later
  // turn: the child's second turn is held until the parent's spawn turn closes,
  // so that notice can only arrive at an idle parent. The parent awaits only the
  // child's unfenced first Activation, so the child cannot deadlock it.
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession !== undefined || event.type !== 'turn/end') return
    if (event.data.turn !== 1) return
    parentClosed = true
    parentTurnClosed.resolve(undefined)
  })

  // Remap the placeholder child id in a send_message to the live child. The
  // child id the model "knows" is authored into the transcript, while the
  // running child is minted with a random id, so without this the messages
  // would never reach the live child.
  let realChildId: string | undefined
  const subagents = ctx.subagents as unknown as {
    sendMessage: (sender: unknown, targetId: SessionId, content: unknown, options: unknown) => Promise<unknown>
  }
  const deliver = subagents.sendMessage.bind(subagents)
  subagents.sendMessage = (sender, targetId, content, options) => {
    const mapped = targetId === PLACEHOLDER_CHILD_ID && realChildId !== undefined
      ? SessionId(realChildId)
      : targetId
    return deliver(sender, mapped, content, options)
  }

  // Both authored messages reach the child inbox before the unknown-id lookup
  // runs, so the accepted order is what the transcript records. The first
  // child enqueue is the initial delegation, which also pins the real child id.
  let accepted = 0
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent.session.header.parentSession === undefined) {
      if (message.source.kind === 'subagent-settled') childSettledOnce.resolve(undefined)
      return
    }
    if (realChildId === undefined) realChildId = agent.session.header.id
    accepted += 1
    if (accepted >= CHILD_MESSAGES) followupsAccepted.resolve(undefined)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (agent.session.header.parentSession === undefined) {
      // The first send_message must find a settled child so Steer cold-resumes
      // it into its own second turn instead of extending its first.
      if (!publishedFailure && turn === 1 && step === FIRST_SEND_MESSAGE_STEP) await childSettledOnce.promise
      return next()
    }
    // The child's first turn runs unfenced so the parent can wait for it. The
    // published-failure variant's child never reaches a step (its follow-up
    // throws), and its parent turn awaits that child, so only the continuable
    // scenario takes the settlement fence.
    if (publishedFailure || turn === 1) return next()
    await followupsAccepted.promise
    if (!parentClosed) await parentTurnClosed.promise
    return next()
  })

  // The child's ordinary durability checkpoints succeed; the checkpoint that
  // follows its claim of the third message fails, turning that turn/end into a
  // durable error the parent never sees.
  let claimed = 0
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    if (agent.session.header.parentSession === undefined) return
    claimed += 1
  })
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    if (claimed >= CHILD_MESSAGES) throw new Error('snapshot disk full')
  })
}
