/** Real user-terminal cleanup while denied-response cancellation remains pending. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.each(['403', '503'] as const)('revokes the terminal before HTTP %s cancellation acknowledgement', async (status) => {
  const fixture = new URL('../../../../../examples/headless-agent/tests/fixtures/terminal-revocation/', import.meta.url)
  await withAuxiliaryModelHarness(fixture, { provider: 'terminal-revocation-fixture', model: 'main-model' }, async (harness, options) => {
    if (options.env === undefined) throw new Error('Terminal fixture requires its owned environment')
    options.env.DSH_TERMINAL_REVOKE_STATUS = status
    const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8')) as {
      reply: string
      '403': unknown
      '503': unknown
    }
    await harness.start()
    const result = await harness.run('Check terminal permission revocation.', { sessionId: 'terminal-revocation' })
    expect(result.finalResponse, JSON.stringify(result)).toBe(expected.reply)
    expect(JSON.parse(await readFile(join(options.cwd, 'terminal-revocation-proof.json'), 'utf8')) as unknown).toEqual(expected[status])
  })
})
