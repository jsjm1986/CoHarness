import { expect, it } from 'vitest'
import { assertAndroidBridgeEvidence, startAndroidBridgeFixture } from './android-bridge-fixture.ts'

it('requires the actual activity scenario instead of an empty or skipped green', () => {
  const output = 'INSTRUMENTATION_STATUS: class=com.coharness.NativePushBridgeTest\n'
    + 'INSTRUMENTATION_STATUS: test=realActivityDeliversLaunchIntentThroughTheWebViewBridge\n'
    + 'INSTRUMENTATION_STATUS_CODE: 0\nOK (3 tests)\nINSTRUMENTATION_CODE: -1\n'
  expect(() => { assertAndroidBridgeEvidence(output) }).not.toThrow()
  for (const invalid of ['OK (0 tests)', 'OK (2 tests)', output.replace('STATUS_CODE: 0', 'STATUS_CODE: -3'), output + 'FAILURES!!!']) {
    expect(() => { assertAndroidBridgeEvidence(invalid) }).toThrow('did not prove')
  }
})

it('keeps independent observations and rejects malformed native payloads on a private endpoint', async () => {
  const fixture = await startAndroidBridgeFixture()
  const endpoint = `http://127.0.0.1:${String(fixture.port)}`
  try {
    expect(await (await fetch(`${endpoint}/observed?session=one`)).json()).toEqual({ observed: null })
    expect((await fetch(`${endpoint}/observed`, { method: 'POST', body: 'invalid JSON' })).status).toBe(400)
    expect((await fetch(`${endpoint}/observed`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await fetch(`${endpoint}/observed`, { method: 'POST', body: JSON.stringify({ sessionId: 'one', eventSeq: '42' }) })).status).toBe(204)
    expect(await (await fetch(`${endpoint}/observed?session=one`)).json()).toEqual({
      observed: { count: 1, payload: { sessionId: 'one', eventSeq: '42' } },
    })
    expect(await (await fetch(`${endpoint}/observed?session=two`)).json()).toEqual({ observed: null })
  } finally { await fixture.close() }
})
