/** Exact Runtime task ownership and passive catalog discovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe,expect,it,vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { ScheduleCatalogEntry,ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createRuntimeTaskCatalogs } from '../src/client/runtime-catalogs.ts'

it('shares one source per Runtime, preserves colliding IDs, and never starts a disconnected target',async()=>{
  const ctx=new Context(),target:ConnectionRuntimeTarget={ kind:'personal',runtimeId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NonNullable<ConnectionRuntimeTarget['runtimeId']> }
  const id='same-task' as ScheduleId,raw='same-session' as SessionId,qualified='b/same-session' as SessionId
  const row: ScheduleCatalogEntry = { id, sessionId: raw, kind: 'at', title: 'Owned task', prompt: 'No execution',
    scheduledAt: '2026-11-01T00:00:00.000Z', status: 'active' }
  const api=()=>({
    catalog:vi.fn(async()=>({ ok:true as const,value:[row] })),
    delete:vi.fn(async()=>({ ok:true as const,value:{ id,deleted:true } })),
  })
  const a=api(),b=api(),changed=new Set<()=>void>(),disposed=vi.fn()
  const state=createSnapshotStore<'connected'|'disconnected'>('connected')
  const transport={ state },forTarget=vi.fn(()=>transport),prepare=vi.fn()
  ctx.provide('connection',{ forTarget } as never)
  ctx.provide('sessions', { runtimeTargetFor: (session: SessionId) => session === qualified ? target : undefined,
    keyFor: (session: SessionId, owner?: ConnectionRuntimeTarget) => owner === target ? qualified : session,
    usingRuntime: prepare,
  } as never)
  const on=vi.fn((_event:string,listener:()=>void)=>{changed.add(listener);return()=>{changed.delete(listener);disposed()}})
  const captured={ schedule:b,$on:on }
  const capture=vi.fn((owner?:ConnectionRuntimeTarget)=>owner===undefined?{ schedule:a,$on:()=>()=>{} }:captured)
  ctx.provide('remote',{ schedule:a,$on:()=>()=>{},$forTarget:capture } as never)
  const catalogs=createRuntimeTaskCatalogs(ctx),mine=catalogs.forSession(qualified)
  expect(catalogs.forTarget(target)).toBe(mine)
  expect(b.catalog).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  const stop=mine.source.hooks.catalog.subscribe(()=>{})
  const baseStop=catalogs.base.source.hooks.catalog.subscribe(()=>{})
  try{
    await vi.waitFor(()=>{ expect(mine.source.hooks.catalog.getSnapshot().status).toBe('ready') })
    expect(mine.source.hooks.catalog.getSnapshot().records[0]?.sessionId).toBe(qualified)
    expect(catalogs.base.source.hooks.catalog.getSnapshot().records[0]?.sessionId).toBe(raw)
    await mine.source.onDelete(id)
    expect(b.delete).toHaveBeenCalledExactlyOnceWith({ sessionId:qualified,id })
    expect(a.delete).not.toHaveBeenCalled()
    const count=b.catalog.mock.calls.length
    state.set('disconnected')
    await vi.waitFor(()=>{ expect(mine.source.hooks.catalog.getSnapshot().status).toBe('error') })
    expect(b.catalog).toHaveBeenCalledTimes(count)
    expect(mine.source.hooks.catalog.getSnapshot().records).toHaveLength(1)
    for(const listener of changed)listener()
    await Promise.resolve()
    expect(b.catalog).toHaveBeenCalledTimes(count)
    expect(prepare).not.toHaveBeenCalled()
    state.set('connected')
    await vi.waitFor(()=>{ expect(b.catalog).toHaveBeenCalledTimes(count+1) })
    expect(capture.mock.calls).toEqual([[undefined],[target]])
  }finally{stop();baseStop();await ctx.fiber.dispose()}
  expect(disposed).toHaveBeenCalledOnce()
})

describe('unavailable task transports',()=>{
  it('refuses another Runtime instead of using the bootstrap catalog',async()=>{
    const ctx=new Context()
    const remote={ schedule:{ catalog:vi.fn() },$on:()=>()=>{},$forTarget:()=>remote }
    ctx.provide('remote',remote as never)
    try{expect(()=>createRuntimeTaskCatalogs(ctx).forTarget({ kind:'project',projectId:7 })).toThrow('connection is unavailable')}
    finally{await ctx.fiber.dispose()}
  })
})
