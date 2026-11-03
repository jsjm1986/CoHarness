/** Authorized Runtime management destinations from Workspace and Session metadata. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from './contract/store.ts'
import type { ISessions } from './contract/sessions.ts'
import type { IWorkspaces } from './contract/workspaces.ts'
import type { DeploymentContextRuntime } from './deployment-context.ts'
import type { PersonalRuntimeDirectory } from './personal-directory.ts'

/** One explicit management destination; the base key keeps its document owner. */
export interface RuntimeEnvironment {
  readonly key: 'base' | NonNullable<ConnectionRuntimeTarget['runtimeId']>
  readonly target?: ConnectionRuntimeTarget
  readonly name?: string
  readonly available: boolean
}

/** Entry policy and the already-discovered authorized Runtime destinations. */
export interface RuntimeEnvironments {
  readonly showComputer: boolean
  readonly choices: readonly RuntimeEnvironment[]
  readonly status: 'loading' | 'ready' | 'error'
}

/**
 * Observe authorized metadata without preparing a Runtime or opening another connection.
 * @param ctx - lifetime of the management directory.
 * @param connection - bootstrap Host and connection metadata.
 * @param sessions - authorized Session metadata and its Runtime identities.
 * @param workspaces - Workspace directory refresh state.
 * @param deployment - browser entry policy.
 * @param personalDirectory - personal Runtime metadata retained across personal and project spaces.
 * @returns current targets; revoked targets are removed without retargeting an open page.
 */
export function createRuntimeEnvironments(
  ctx: Context, connection: ConnectionHandle, sessions: ISessions, workspaces: IWorkspaces,
  deployment: DeploymentContextRuntime, personalDirectory: HostObservable<readonly PersonalRuntimeDirectory[]>,
): HostObservable<RuntimeEnvironments> {
  const state = createSnapshotStore<RuntimeEnvironments>({
    showComputer: false, choices: [{ key: 'base', available: true }], status: 'loading',
  })
  let signature = ''
  const read = (): void => {
    const policy = deployment.getSnapshot()
    const workspaceState = workspaces.list.getSnapshot()
    const sessionState = sessions.list.getSnapshot()
    const bootstrap = connection.hostDescription.getSnapshot()?.runtimeTarget
    const groups = personalDirectory.getSnapshot()
    const metadata = groups.find(group => group.runtime.runtimeId === bootstrap?.runtimeId)?.runtime
      ?? sessionState.ids.map(id => sessionState.byId[id]?.runtime)
        .find(target => bootstrap?.runtimeId !== undefined && target?.runtimeId === bootstrap.runtimeId)
    const base = bootstrap === undefined ? undefined : { ...metadata, ...bootstrap }
    const localNode = policy.context?.scope === 'local' ? policy.context.entry.nodeId : base?.nodeId
    const choices: RuntimeEnvironment[] = [{
      key: 'base', available: policy.context?.scope !== 'local' || base?.nodeId === undefined
        || base.nodeId === policy.context.entry.nodeId,
      ...(base === undefined ? {} : { target: base }),
      ...(base?.nodeName === undefined ? {} : { name: base.nodeName }),
    }]
    const known = new Set([base?.runtimeId])
    const allowed = (target: ConnectionRuntimeTarget): boolean => policy.aggregateComputers
      || localNode !== undefined && target.nodeId === localNode
    for (const group of groups) {
      if (known.has(group.runtime.runtimeId) || !allowed(group.runtime)) continue
      known.add(group.runtime.runtimeId)
      choices.push({ key: group.runtime.runtimeId, target: group.runtime, name: group.runtime.nodeName,
        available: group.status === 'active' })
    }
    for (const id of sessionState.ids) {
      const target = sessionState.byId[id]?.runtime
      if (target?.kind !== 'project' || target.runtimeId === undefined || known.has(target.runtimeId) || !allowed(target)) continue
      known.add(target.runtimeId)
      choices.push({ key: target.runtimeId, target, available: true,
        ...(target.nodeName === undefined ? {} : { name: target.nodeName }) })
    }
    const next: RuntimeEnvironments = {
      showComputer: policy.showComputer, choices,
      status: workspaceState.directoryState === 'error' ? 'error'
        : workspaceState.directoryState === 'loading' ? 'loading' : 'ready',
    }
    const serialized = JSON.stringify(next)
    if (serialized !== signature) { signature = serialized; state.set(next) }
  }
  ctx.effect(() => {
    const stops = [workspaces.list.subscribe(read), sessions.list.subscribe(read), personalDirectory.subscribe(read),
      connection.hostDescription.subscribe(read), deployment.subscribe(read)]
    read()
    return () => { for (const stop of stops) stop() }
  }, 'runtime: management directory')
  return state
}
