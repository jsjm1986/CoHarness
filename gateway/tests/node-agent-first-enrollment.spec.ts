/** Source and native deployment coverage for a Node Agent's first credential directory. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { firstEnrollment } from './fixtures/node-agent-first-enrollment.mjs'

it('persists first enrollment and reports a center refusal without hanging', async () => {
  const result = await firstEnrollment(process.env.HGW_TEST_NODE_AGENT_BUILT_ENTRY)
  await expect(JSON.stringify(result, null, 2) + '\n').toMatchFileSnapshot(
    fileURLToPath(new URL('./expected/node-agent-first-enrollment.json', import.meta.url)))
})
