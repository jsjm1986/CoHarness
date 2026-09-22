import { describe, expect, it } from 'vitest'
import { EVENT_API, queryEventApi, queryServiceApi, SERVICE_API } from '../src/client/api-catalog.ts'

describe('Client Cordis inspect catalog', () => {
  it('serves a compact catalog directory for every catalogued service', () => {
    const result = queryServiceApi() as {
      mode: string
      services: { key: string; description: string; methods: { signature: string }[] }[]
    }
    expect(result.mode).toBe('catalog')
    expect(result.services.map(service => service.key)).toEqual(SERVICE_API.map(service => service.key))
    for (const service of result.services) {
      expect(service.methods.length).toBeGreaterThan(0)
      for (const method of service.methods) expect(method.signature.length).toBeGreaterThan(0)
    }
  })

  it('serves one exact service contract with access recipes and its referenced-type closure', () => {
    const key = SERVICE_API[0]!.key
    const result = queryServiceApi(key) as {
      mode: string
      service: {
        key: string
        access: {
          optional: { expression: string; requiresUndefinedCheck: boolean }
          hardDependency: { inject: string[]; expression: string }
        }
        methods: unknown[]
      }
      referencedTypes: { name: string; declaration: string }[]
    }
    expect(result.mode).toBe('service')
    expect(result.service.key).toBe(key)
    expect(result.service.access.optional).toEqual({
      expression: `ctx.get(${JSON.stringify(key)})`,
      requiresUndefinedCheck: true,
    })
    expect(result.service.access.hardDependency.inject).toEqual([key])
    expect(Array.isArray(result.referencedTypes)).toBe(true)
  })

  it('rejects unknown service keys', () => {
    expect(() => queryServiceApi('definitely-not-a-service')).toThrow('no catalogued Service')
  })

  it('serves a compact catalog directory for every catalogued event', () => {
    const result = queryEventApi() as {
      mode: string
      events: { name: string; mode: string; signature: string }[]
    }
    expect(result.mode).toBe('catalog')
    expect(result.events.map(event => event.name)).toEqual(EVENT_API.map(event => event.name))
    const names = EVENT_API.map(event => event.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('serves one exact event contract with parameters and referenced types', () => {
    const name = EVENT_API[0]!.name
    const result = queryEventApi(name) as {
      mode: string
      event: { name: string; parameters: unknown[] }
      referencedTypes: { name: string }[]
    }
    expect(result.mode).toBe('event')
    expect(result.event.name).toBe(name)
    expect(Array.isArray(result.event.parameters)).toBe(true)
    expect(Array.isArray(result.referencedTypes)).toBe(true)
  })

  it('rejects unknown event names', () => {
    expect(() => queryEventApi('definitely/not-an-event')).toThrow('no catalogued Event')
  })
})
