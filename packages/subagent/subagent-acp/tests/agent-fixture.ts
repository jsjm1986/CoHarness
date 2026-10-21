import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

/**
 * Detached parent Agent backed by a real in-memory Session. Directory-aware
 * providers read `session.header.cwd` as the effective workspace a child
 * inherits, and the real Session supplies `append` for the child's durable
 * catalog event.
 * @param cwd - header working directory; omit for a cwd-less header. Values
 *   that fail the SessionHeader absoluteness contract are admitted verbatim:
 *   several specs exist precisely to prove the backend rejects a broken
 *   header, which `Session.create`'s storage-side validation would refuse
 *   to construct.
 * @param id - shared Agent and Session identity.
 * @param ctx - optional agent-scoped context; a fresh Context otherwise.
 * @returns a fully-typed Agent whose only backing is the detached Session.
 */
export function parentAgent(cwd?: string, id = 'parent', ctx?: Context): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId)
  if (cwd !== undefined) {
    Object.defineProperty(session, 'header', {
      value: { ...session.header, cwd } satisfies SessionHeader,
    })
  }
  return {
    id: sessionId,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: ctx ?? new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('test parent has no turn driver to inject into') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}
