/** Shared Runtime management metadata remains passive and follows entry scope. */
import { Context } from '@deepseek-ai/cordis'
import { expect,it,vi } from 'vitest'
import type { ConnectionHandle,ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions,IWorkspaces } from '../src/client/index.ts'
import type { DeploymentContextRuntime } from '../src/client/deployment-context.ts'
import { createSnapshotStore } from '../src/client/contract/store.ts'
import { createRuntimeEnvironments } from '../src/client/runtime-environments.ts'
import type { PersonalRuntimeDirectory } from '../src/client/personal-directory.ts'
import type { DeploymentContextSnapshot } from '../src/client/deployment-context.ts'

it('lists twenty granted computers without connecting, and removes remote choices in local entry scope',async()=>{
  const ctx=new Context(),forTarget=vi.fn(),start=vi.fn()
  const groups=Array.from({ length:20 },(_,index)=>({ runtime:{ kind:'personal',runtimeId:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,nodeId:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,nodeName:`Computer ${index}` },status:'active',observedState:'stopped',syncedAt:null,items:[] }))
  const first=groups[0]!.runtime as ConnectionRuntimeTarget
  const hostDescription=createSnapshotStore({ runtimeTarget:first })
  const workspaces=createSnapshotStore({ computerGroups:groups,directoryState:'ready' })
  const sessions=createSnapshotStore({ ids:[],byId:{} })
  const policy=createSnapshotStore({ aggregateComputers:true,showComputer:true })
  const connection={ hostDescription,forTarget,start } as unknown as ConnectionHandle
  try{
    const directory = createRuntimeEnvironments(ctx, connection,
      { list: sessions } as unknown as ISessions, { list: workspaces } as unknown as IWorkspaces,
      policy as unknown as DeploymentContextRuntime, createSnapshotStore(groups) as never)
    const stop=directory.subscribe(()=>{})
    expect(directory.getSnapshot().choices).toHaveLength(20)
    expect(forTarget).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled()
    policy.set({ aggregateComputers:false,showComputer:true })
    expect(directory.getSnapshot()).toMatchObject({ showComputer:true,choices:[{ key:'base',target:first }] })
    policy.set({ aggregateComputers:false,showComputer:false })
    expect(directory.getSnapshot().showComputer).toBe(false)
    const before=directory.getSnapshot();stop();await ctx.fiber.dispose()
    policy.set({ aggregateComputers:true,showComputer:true })
    expect(directory.getSnapshot()).toBe(before)
  }finally{await ctx.fiber.dispose()}
})

it('keeps same-computer Runtimes in single mode and resolves a bare bootstrap identity from granted metadata', async () => {
  const ctx = new Context()
  const nodeA = '10000000-0000-4000-8000-000000000000'
  const nodeB = '10000000-0000-4000-8000-000000000001'
  const group = (ordinal: number, node: string): PersonalRuntimeDirectory => ({
    runtime: { kind: 'personal', runtimeId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
      nodeId: node, nodeName: node === nodeA ? 'Local computer' : 'Other computer' } as PersonalRuntimeDirectory['runtime'],
    status: 'active', observedState: 'stopped', syncedAt: null, items: [],
  })
  const groups = [group(0, nodeA), group(1, nodeA), group(2, nodeB)]
  const bootstrap = { kind: 'personal', runtimeId: groups[0]!.runtime.runtimeId }
  const hostDescription = createSnapshotStore({ runtimeTarget: bootstrap })
  const metadata = createSnapshotStore<readonly PersonalRuntimeDirectory[]>(groups)
  const policy = createSnapshotStore<DeploymentContextSnapshot>({
    phase: 'ready', showComputer: false, aggregateComputers: false,
    context: { mode: 'single', revision: '1', entry: { nodeId: groups[0]!.runtime.nodeId, name: 'Entry' },
      primary: null, scope: 'local', role: 'standalone', refreshAfterMs: 30000, legacyMigrationRequired: false },
  })
  const forTarget = vi.fn(), start = vi.fn()
  const workspaceList = createSnapshotStore({ directoryState: 'ready' })
  const sessionList = createSnapshotStore({ ids: [], byId: {} })
  try {
    const directory = createRuntimeEnvironments(ctx, { hostDescription, forTarget, start } as unknown as ConnectionHandle,
      { list: sessionList } as unknown as ISessions, { list: workspaceList } as unknown as IWorkspaces,
      policy as unknown as DeploymentContextRuntime, metadata)
    expect(directory.getSnapshot()).toMatchObject({ showComputer: false, choices: [
      { key: 'base', available: true, target: groups[0]!.runtime, name: 'Local computer' },
      { key: groups[1]!.runtime.runtimeId, target: groups[1]!.runtime },
    ] })
    metadata.set([groups[0]!, { ...groups[1]!, status: 'disabled' }, groups[2]!])
    expect(directory.getSnapshot().choices[1]?.available).toBe(false)
    expect(forTarget).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it('retains a now-remote bootstrap target as unavailable when the entry becomes local', async () => {
  const ctx = new Context()
  const bootstrap = { kind: 'personal', runtimeId: '00000000-0000-4000-8000-000000000001',
    nodeId: '10000000-0000-4000-8000-000000000001', nodeName: 'Remote computer' } as ConnectionRuntimeTarget
  const hostDescription = createSnapshotStore({ runtimeTarget: bootstrap })
  const localNode = '10000000-0000-4000-8000-000000000000' as NonNullable<ConnectionRuntimeTarget['nodeId']>
  const policy = createSnapshotStore<DeploymentContextSnapshot>({ phase: 'ready', showComputer: false, aggregateComputers: false,
    context: { mode: 'single', revision: '2', entry: { nodeId: localNode, name: 'Local computer' },
      primary: null, scope: 'local', role: 'standalone', refreshAfterMs: 30000, legacyMigrationRequired: false } })
  try {
    const directory = createRuntimeEnvironments(ctx, { hostDescription } as unknown as ConnectionHandle,
      { list: createSnapshotStore({ ids: [], byId: {} }) } as unknown as ISessions,
      { list: createSnapshotStore({ directoryState: 'ready' }) } as unknown as IWorkspaces,
      policy as unknown as DeploymentContextRuntime, createSnapshotStore([]))
    expect(directory.getSnapshot().choices).toEqual([{ key: 'base', target: bootstrap, name: 'Remote computer', available: false }])
  } finally { await ctx.fiber.dispose() }
})
