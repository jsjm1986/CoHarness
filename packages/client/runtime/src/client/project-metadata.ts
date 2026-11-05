/** Project display fields are authorized and read together on their project's owning computer. */
import type { SessionRuntimeTarget } from './contract/sessions.ts'

/** Governance identities that must match before displaying a name or local path. */
export interface ProjectOwnerRef {
  readonly projectId: number
  readonly runtimeId?: NonNullable<SessionRuntimeTarget['runtimeId']>
}

/** A verified project label and root directory from the explicitly selected node. */
export interface OwnerProjectDisplay extends ProjectOwnerRef {
  readonly nodeId: NonNullable<SessionRuntimeTarget['nodeId']>
  readonly runtimeId: NonNullable<SessionRuntimeTarget['runtimeId']>
  readonly name: string
  readonly rootPath: string
}

/** Validate the complete bounded response; a missing or mixed owner invalidates the page.
 * @param value - decoded owner response.
 * @param nodeId - selected owning node.
 * @param projects - exact authorized public IDs and any known allocations.
 * @returns names and paths only for the captured owner.
 */
export function readOwnerProjects(value: unknown, nodeId: string, projects: readonly ProjectOwnerRef[]): OwnerProjectDisplay[] {
  if (value === null || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) throw new Error('Invalid project directory')
  const wanted = new Map(projects.map(row => [row.projectId, row.runtimeId]))
  const result: OwnerProjectDisplay[] = []
  for (const candidate of value.items as unknown[]) {
    if (candidate === null || typeof candidate !== 'object') throw new Error('Invalid project metadata')
    const row = candidate as Record<string, unknown>
    if (row.nodeId !== nodeId || typeof row.projectId !== 'number' || !wanted.has(row.projectId)
      || typeof row.runtimeId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(row.runtimeId)
      || wanted.get(row.projectId) !== undefined && wanted.get(row.projectId) !== row.runtimeId
      || typeof row.name !== 'string' || !row.name || typeof row.rootPath !== 'string' || !row.rootPath) throw new Error('Project owner mismatch')
    wanted.delete(row.projectId)
    result.push({ projectId: row.projectId, nodeId: nodeId as OwnerProjectDisplay['nodeId'], runtimeId: row.runtimeId as OwnerProjectDisplay['runtimeId'],
      name: row.name, rootPath: row.rootPath })
  }
  if (wanted.size) throw new Error('Project names are unavailable from the owning computer')
  return result
}
