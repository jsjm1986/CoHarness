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
