/** Real SDK turns recover from a failed historical Git probe without reusing its rejected initialization. */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from '../../../../../examples/headless-agent/tests/auxiliary-model-fixture.ts'

it.skipIf(process.platform === 'win32').each([true, false])('recovers explicit SDK turns and reuses successful probes, Git repository: %s', async (repository) => {
  await withAuxiliaryModelHarness(new URL('../../../../../packages/deliverables/workspace-changes/tests/fixtures/recovery/', import.meta.url),
    { provider: 'review-recovery', model: 'review-recovery' }, async (harness, options) => {
      await writeFile(join(options.cwd, '.gitignore'), '.dsh/\n.agents/\n.snapshot-patches/\n.reviews/\n.fixture-state/\n')
      await writeFile(join(options.cwd, 'seed.txt'), 'Fixture workspace\n')
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', ...args], { cwd: options.cwd, stdio: 'pipe' })
      if (repository) {
        git('init', '-q')
        git('add', '.gitignore', 'seed.txt')
        git('commit', '-q', '-m', 'Fixture baseline')
      }
      const observation = async () => JSON.parse(await readFile(join(options.cwd, '.fixture-state', 'observations.json'), 'utf8')) as {
        probes: number
        modelRequests: number
      }
      const session = harness.session()
      const first = await session.run('First request must stop before model execution.')
      const failed = await observation()
      expect(failed, JSON.stringify(first.events.filter(event => event.type === 'turn/end'))).toEqual({ probes: 1, modelRequests: 0 })
      expect(first.events.find(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'error' } })
      const firstIncomplete = first.events.some(event => event.type === 'workspace/changes' && event.data.incomplete === true)
      expect(firstIncomplete).toBe(true)
      const second = await session.run('Retry the historical review and then answer.')
      const recovered = await observation()
      expect(second.finalResponse).toBe('REVIEW_RECOVERED')
      expect(recovered).toEqual({ probes: 2, modelRequests: 1 })
      const third = await session.run('Continue with the same successful Git initialization.')
      const reused = await observation()
      expect(third.finalResponse).toBe('REVIEW_RECOVERED')
      expect(reused).toEqual({ probes: 2, modelRequests: 2 })
      await harness.close()
      const cleanup: unknown = JSON.parse(await readFile(join(options.cwd, '.fixture-state', 'cleanup.json'), 'utf8'))
      expect(cleanup).toEqual({ hostMappingRestored: true, spawnRestored: true })
      await expect(JSON.stringify({ first: failed, firstIncomplete, second: recovered, third: reused,
        responses: [first.finalResponse, second.finalResponse, third.finalResponse], cleanup }, null, 2) + '\n').toMatchFileSnapshot(
        fileURLToPath(new URL('../../../../../packages/deliverables/workspace-changes/tests/expected/recovery.json', import.meta.url)))
    })
}, 120_000)
