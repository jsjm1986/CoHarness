/** Task-page lifetime prepares only the explicitly selected Runtime. */
import { Context } from '@deepseek-ai/cordis'
import { describe,expect,it,vi } from 'vitest'
import type { ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import { createCatalogSource } from '../src/client/catalog-source.ts'
import { createTaskPageCatalog } from '../src/client/page-catalog.ts'

const target:ConnectionRuntimeTarget={ kind:'project',projectId:7 }

describe('selected task Runtime lifetime',()=>{
  it('waits for preparation, shares its catalog, and releases only its own hold',async()=>{
    const ctx=new Context(),ready=Promise.withResolvers<undefined>()
    const prepare=vi.fn((_target:ConnectionRuntimeTarget,_signal:AbortSignal)=>ready.promise),released=vi.fn()
    const usingRuntime=vi.fn(async (_target:ConnectionRuntimeTarget,signal:AbortSignal,operation:(signal:AbortSignal)=>Promise<void>)=>{
      try{await operation(signal)}finally{released()}
    })
    ctx.provide('sessions',{ prepareRuntime:prepare,usingRuntime } as never)
    const list=vi.fn(async()=>({ ok:true as const,value:[] }))
    const unsubscribe=vi.fn()
    const source=createCatalogSource({ list,remove:vi.fn(),subscribeChanged:()=>unsubscribe,subscribeReset:()=>()=>{} })
    const page=createTaskPageCatalog(ctx,target,source)
    expect(prepare).not.toHaveBeenCalled()
    const stop=page.hooks.catalog.subscribe(()=>{})
    try{
      expect(prepare).toHaveBeenCalledExactlyOnceWith(target,expect.any(AbortSignal))
      expect(page.hooks.catalog.getSnapshot().status).toBe('loading')
      expect(list).not.toHaveBeenCalled()
      ready.resolve(undefined)
      await vi.waitFor(()=>{ expect(page.hooks.catalog.getSnapshot().status).toBe('ready') })
      expect(list).toHaveBeenCalledOnce()
      expect(released).not.toHaveBeenCalled()
    }finally{stop();await ctx.fiber.dispose()}
    expect(released).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(prepare.mock.calls[0]?.[1].aborted).toBe(true)
  })

  it('does not publish or read a late preparation after its page closes',async()=>{
    const ctx=new Context(),ready=Promise.withResolvers<undefined>(),list=vi.fn(async()=>({ ok:true as const,value:[] }))
    ctx.provide('sessions',{ prepareRuntime:()=>ready.promise,usingRuntime:async (_target:ConnectionRuntimeTarget,signal:AbortSignal,operation:(signal:AbortSignal)=>Promise<void>)=>operation(signal) } as never)
    const source=createCatalogSource({ list,remove:vi.fn(),subscribeChanged:()=>()=>{},subscribeReset:()=>()=>{} })
    const page=createTaskPageCatalog(ctx,target,source),listener=vi.fn()
    const stop=page.hooks.catalog.subscribe(listener)
    stop();listener.mockClear();ready.resolve(undefined);await ctx.fiber.dispose()
    expect(list).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })
})
