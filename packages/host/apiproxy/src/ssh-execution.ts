/**
 * Session SSH execution realms. A session whose header carries `sshTarget`
 * joins a standing composition mounted inside a realm scope where the
 * authorized target's `ssh`/`fs`/`subprocess`/`sandbox` providers shadow the
 * host's — one connection per (preset, target, revocation subject)
 * generation, shared by every agent the same caller joins to it.
 *
 * Why a realm and not a per-agent shadow: preset compositions are standing
 * mounts — one subtree shared by every joined agent — and a tool body
 * resolves `ctx.fs` on the context it was REGISTERED under, not the calling
 * agent's. Realm keys extend the standing key (`{agentPreset, realm}`), so
 * the shadow lives on the standing scope context the tool rows derive their
 * isolation labels from.
 *
 * Why the revocation subject is part of the key: a grant is narrowed by
 * `{userId, projectId}`, and a shared connection cannot fail closed for one
 * caller while serving another. Keying the realm by subject confines one
 * grant's revocation to exactly the sessions it authorized.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'

/** Service names re-labeled inside an SSH standing realm. */
const SSH_REALM_SERVICES = ['ssh', 'fs', 'subprocess', 'sandbox'] as const

/** Realm key prefix; the subject triple completes it. */
const SSH_REALM_PREFIX = 'ssh-target/'

/**
 * The realm key one SSH target and revocation subject compose under.
 * @param targetId - registered SSH target public id from the session header.
 * @param userId - the authorizing principal's user id.
 * @param projectId - the runtime's project identity, when project-launched.
 * @returns the `realm` argument for `AgentPresets.mount()`.
 */
export function sshRealmKey(targetId: number, userId: number, projectId?: number): string {
  return projectId === undefined
    ? `${SSH_REALM_PREFIX}${targetId}/u${userId}`
    : `${SSH_REALM_PREFIX}${targetId}/u${userId}/p${projectId}`
}

/**
 * Register `targetId`'s realm hook on the roster under `realm`, idempotently.
 *
 * The hook resolves the creating caller's interactive grant at
 * generation-creation time — a new generation after revocation re-checks
 * admission — and wires the grant's abort to connection disposal and
 * generation retirement. Every joiner of the realm shares the hook's
 * revocation subject, so one abort retires exactly the mounts it authorized.
 * Two sessions racing the first mount share the single-flight inside
 * `ensureStanding`, so the hook runs once per generation.
 * @param presets - the agent-preset roster to register the realm on.
 * @param realm - the subject-scoped key from {@link sshRealmKey}.
 * @param targetId - the session-bound SSH target.
 */
export function ensureSshRealm(presets: AgentPresets, realm: string, targetId: number): void {
  presets.registerRealm(realm, scopeCtx => mountSshProviders(scopeCtx, targetId, () => {
    presets.invalidateRealm(realm)
  }))
}

/**
 * Resolve the bound target and mount its provider subtree inside `scopeCtx`.
 *
 * Resolution runs under the creating caller's interactive authority. The
 * isolate labels for the SSH-carried services are shadowed on the scope
 * context itself so every row of the preset subtree — whose contexts derive
 * from it — resolves `fs`/`subprocess`/`sandbox`/`ssh` to these providers.
 * A revocation mid-mount or mid-session retires the generation and disposes
 * the connection, which fail-closes every provider call routed through it;
 * scope disposal unrolls the same effects.
 * @param scopeCtx - the realm's standing scope context.
 * @param targetId - the registered target to resolve and connect.
 * @param retire - drops this realm's standing pointer so later joins rebuild.
 * @throws when the runtime has no SSH authorization service, the caller is
 *   not qualified for the target, or connection/helper verification fails.
 */
async function mountSshProviders(scopeCtx: Context, targetId: number, retire: () => void): Promise<void> {
  const authorization = scopeCtx.get('sshAuthorization')
  if (authorization === undefined) {
    throw new Error('session sshTarget requires a managed runtime providing sshAuthorization')
  }
  const resolved = await authorization.resolve(targetId)
  const isolate = Object.create(scopeCtx[Context.isolate]) as Record<string, symbol>
  for (const name of SSH_REALM_SERVICES) isolate[name] = Symbol(name)
  scopeCtx[Context.isolate] = isolate
  const connection = new SshConnection(scopeCtx, resolved.config)
  const revoke = (): void => {
    retire()
    void connection.dispose()
  }
  resolved.signal.addEventListener('abort', revoke, { once: true })
  scopeCtx.effect(() => () => { resolved.signal.removeEventListener('abort', revoke) })
  try {
    // The constructor already launched OpenSSH; awaiting `ready` performs the
    // service's init contract (remote identity + helper digest) before
    // dependents can answer. A rejection propagates into generation rollback,
    // and the abort check closes the window between resolve() and listener
    // registration, which an already-aborted signal would never re-fire.
    await connection.ready
    resolved.signal.throwIfAborted()
    new SshFileSystem(scopeCtx)
    new SshSubprocessRuntime(scopeCtx)
    new SshSandboxProvider(scopeCtx)
  } catch (error) {
    resolved.signal.removeEventListener('abort', revoke)
    await connection.dispose()
    throw error
  }
}
