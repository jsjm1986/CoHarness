import { describe, expect, it } from 'vitest'
import { baselineRegistrations, diffRegistrations, registrationSnapshot } from '../src/registration.ts'

describe('personal model registration projection', () => {
  it('records Provider and model additions without retaining credentials', () => {
    const events = diffRegistrations('llm-pi-ai', { providers: {} }, {
      providers: {
        'my gateway': {
          api: 'openai-responses', apiKeyEnv: 'MY_KEY', headers: { Authorization: 'secret' },
          models: [{ id: 'model-a', name: 'A' }],
        },
      },
    }, 123)
    expect(events).toMatchObject([
      { action: 'provider-created', provider: 'my gateway' },
      { action: 'model-created', provider: 'my gateway', model: 'model-a' },
    ])
    expect(JSON.stringify(events)).not.toContain('MY_KEY')
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('reports modifications and deletions at their semantic level', () => {
    const previous = { providers: { p: { baseURL: 'https://one', models: [{ id: 'a', name: 'A' }, { id: 'b' }] } } }
    const next = { providers: { p: { baseURL: 'https://two', models: [{ id: 'a', name: 'A2' }] } } }
    expect(diffRegistrations('llm-pi-ai', previous, next, 456)).toMatchObject([
      { action: 'provider-modified', provider: 'p' },
      { action: 'model-modified', provider: 'p', model: 'a' },
      { action: 'model-deleted', provider: 'p', model: 'b' },
    ])
  })

  it('does not audit unrelated namespaces', () => {
    expect(registrationSnapshot('settings', { providers: { p: {} } })).toBeUndefined()
    expect(diffRegistrations('settings', {}, { providers: { p: {} } })).toEqual([])
  })

  it('uses stable baseline ids so a restart cannot duplicate current state', () => {
    const layer = { providers: { p: { models: [{ id: 'm' }] } } }
    const first = baselineRegistrations('llm-pi-ai', layer, 10)
    const second = baselineRegistrations('llm-pi-ai', layer, 20)
    expect(first).toHaveLength(2)
    expect(second.map(record => record.eventId)).toEqual(first.map(record => record.eventId))
    expect(diffRegistrations('llm-pi-ai', { providers: {} }, layer, 10).map(record => record.eventId))
      .toEqual(first.map(record => record.eventId))
  })
})
