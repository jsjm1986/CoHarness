import { describe, expect, it } from 'vitest'
import { runEventPrincipalScenario } from './fixtures/event-principal-renewal.fixture.ts'

describe('renewable event principal composition', () => {
  it.each([true, false])('registers only event sockets when renewal is enabled=%s', async (enabled) => {
    const result = await runEventPrincipalScenario(enabled)
    expect(result).toMatchObject({ enabled, eventSockets: 2, initialHttpStatus: 200,
      renewalBatches: enabled ? 3 : 0, passedOriginalDeadline: enabled,
      retainedAuthority: enabled, oldHttpStatus: enabled ? 401 : null, releasedOnSocketClose: enabled })
  })
})
