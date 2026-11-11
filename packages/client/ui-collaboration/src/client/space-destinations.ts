/** Account-authorized work destinations shared by the sidebar page and rail menu. */
import { runtimeTargetKey } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollaborationEnvironment, CollaborationSnapshot, ProjectMembership } from './collaboration-client.ts'

/** One navigable space; a project retains its fixed Runtime and computer. */
export interface SpaceDestination {
  id: string
  target: SessionRuntimeTarget
  name: string
  nodeName?: string
  project?: ProjectMembership
  state?: Pick<CollaborationEnvironment, 'observedState' | 'nodeStatus' | 'provisioning' | 'routing'>
  current: boolean
}

/**
 * Combine one personal-space entry with projects retaining their fixed Runtime identities.
 * @param state - verified account context and the directory pages read by this tab.
 * @param entryNodeId - local-only entry's computer; omission permits authorized aggregation.
 * @returns destinations retaining exact Runtime identities whenever the directory supplies them.
 */
export function spaceDestinations(state: CollaborationSnapshot, entryNodeId?: string): SpaceDestination[] {
  const context = state.context
  if (context === undefined) return []
  const projects = new Map(context.projects.map(project => [project.projectId, project]))
  const destinations: SpaceDestination[] = []
  const ids = new Set<string>()
  const projectIds = new Set<number>()
  const add = (target: SessionRuntimeTarget, name: string, nodeName?: string, state?: SpaceDestination['state']): void => {
    const nodeId = target.nodeId ?? (target.runtimeId === context.environment?.id ? context.environment?.nodeId : undefined)
    if (entryNodeId !== undefined && nodeId !== entryNodeId) return
    const id = `space:${runtimeTargetKey(target)}`
    if (ids.has(id)) return
    ids.add(id)
    if (target.kind === 'project') projectIds.add(target.projectId)
    const project = target.kind === 'project' ? projects.get(target.projectId) : undefined
    const current = target.runtimeId !== undefined && context.environment !== undefined
      ? target.runtimeId === context.environment.id
      : target.kind === context.scope.kind && (target.kind === 'personal'
        || context.scope.kind === 'project' && target.projectId === context.scope.projectId)
    if (project?.metadataOnNode && target.kind === 'project') {
      name = project.name
      target = { ...target, projectName: name }
    }
    destinations.push({ id, target, name, current, ...(state === undefined ? {} : { state }),
      ...(nodeName === undefined ? {} : { nodeName }), ...(project === undefined ? {} : { project }) })
  }
  for (const item of [...(state.environments?.items ?? []), ...(state.preferredEnvironments ?? [])]) {
    add(item.target, item.name, item.nodeName, item)
  }
  if (context.scope.kind === 'personal') {
    const environment = context.environment
    add(environment === undefined ? { kind: 'personal' } : { kind: 'personal', runtimeId: environment.id, nodeId: environment.nodeId }, '', environment?.nodeName)
  } else if (context.environment === undefined) add({ kind: 'personal' }, '')
  else add({ kind: 'project', projectId: context.scope.projectId, runtimeId: context.environment.id, nodeId: context.environment.nodeId }, context.scope.projectName, context.environment.nodeName)
  if (context.environment === undefined) {
    for (const project of context.projects) {
      if (!projectIds.has(project.projectId)) add({ kind: 'project', projectId: project.projectId }, project.name)
    }
  }
  const personal = destinations.filter(item => item.target.kind === 'personal')
  const available = personal.filter(item => item.state?.nodeStatus !== 'offline' && item.state?.nodeStatus !== 'draining'
    && item.state?.routing !== 'unavailable' && item.state?.provisioning !== 'preparing')
  const recent = (items: SpaceDestination[]) => (state.recentRuntimeIds ?? [])
    .flatMap(id => items.filter(item => item.target.runtimeId === id))[0]
  const preferred = personal.find(item => item.current)
    ?? recent(available) ?? available[0] ?? recent(personal) ?? personal[0]
  const unified: SpaceDestination = preferred === undefined
    ? { id: 'space:personal', target: { kind: 'personal' }, name: '', current: context.scope.kind === 'personal' }
    : { id: 'space:personal', target: preferred.target, name: '', current: context.scope.kind === 'personal' }
  return [unified, ...destinations.filter(item => item.target.kind === 'project')]
}

/** One row inside a rendered space group: a plain destination or the consolidated multi-computer maintenance entry. */
export type SpaceRowEntry =
  | { readonly kind: 'destination'; readonly destination: SpaceDestination }
  | { readonly kind: 'steward'; readonly destinations: readonly SpaceDestination[] }

/**
 * Fold per-computer maintenance destinations into one expandable row while
 * keeping the group's original ordering; a single steward stays a plain row.
 * @param items - destinations inside one visible group.
 * @param flat - bypass folding while the search query filters identities.
 * @returns row entries in display order.
 */
export function spaceRowEntries(items: readonly SpaceDestination[], flat = false): SpaceRowEntry[] {
  if (flat) return items.map(destination => ({ kind: 'destination', destination }))
  const stewards = items.filter(item => item.project?.kind === 'steward')
  if (stewards.length < 2) return items.map(destination => ({ kind: 'destination', destination }))
  const entries: SpaceRowEntry[] = []
  let placed = false
  for (const destination of items) {
    if (destination.project?.kind !== 'steward') {
      entries.push({ kind: 'destination', destination })
      continue
    }
    if (!placed) {
      entries.push({ kind: 'steward', destinations: stewards })
      placed = true
    }
  }
  return entries
}

/**
 * Display name minus the `·<nodeName>` tail when the name literally carries it.
 * @param destination - one space destination.
 * @returns the name's base part, or the name unchanged.
 */
const stripNodeSuffix = (destination: SpaceDestination): string => {
  const tail = destination.nodeName === undefined ? undefined : `·${destination.nodeName}`
  return tail !== undefined && destination.name.endsWith(tail) ? destination.name.slice(0, -tail.length) : destination.name
}

/**
 * Shared display name for consolidated maintenance destinations: the project
 * name minus its per-computer suffix when every member agrees, otherwise the
 * first member's name prefix before the separator.
 * @param destinations - folded steward destinations, non-empty.
 * @returns the row's display name.
 */
export function stewardSpaceBase(destinations: readonly SpaceDestination[]): string {
  const bases = new Set(destinations.map(stripNodeSuffix))
  if (bases.size === 1) return [...bases][0] ?? ''
  return destinations[0]?.name.split('·')[0] ?? ''
}

/**
 * A folded child's display name: under the consolidated row the `·<nodeName>`
 * suffix duplicates the computer line, so the name line keeps only the base.
 * @param destination - one member of a folded steward entry.
 * @returns the name without its redundant node suffix.
 */
export function stewardChildName(destination: SpaceDestination): string {
  return stripNodeSuffix(destination)
}
