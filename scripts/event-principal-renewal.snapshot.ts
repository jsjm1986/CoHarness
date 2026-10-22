/** Keyless transcript of the real managed Runtime's WebSocket and HTTP carriers. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runEventPrincipalScenario } from '../packages/context/gateway-runtime/tests/fixtures/event-principal-renewal.fixture.ts'

it('keeps event sockets beyond their initial grant without renewing HTTP or disabled streams', async () => {
  const results = []
  for (const enabled of [true, false]) results.push(await runEventPrincipalScenario(enabled))
  const transcript = '# Managed event principal renewal\n\n' + results.map(result =>
    JSON.stringify(result, null, 2)).join('\n\n') + '\n'
  await expect(transcript).toMatchFileSnapshot(fileURLToPath(new URL('../snapshots/web/event-principal-renewal.expected.md', import.meta.url)))
})
