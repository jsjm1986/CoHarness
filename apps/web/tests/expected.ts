/** Browser expected-output comparison shared by Host and Gateway compositions. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** Snapshot mode for the lane, from $DSH_SNAPSHOT (same vocabulary as the other snapshot suites). */
export type WebSnapshotMode = 'replay' | 'record' | 'refresh'

/**
 * Resolve and validate the lane's snapshot mode.
 * @returns the active mode; unset/empty selects replay.
 */
export function webSnapshotMode(): WebSnapshotMode {
  const value = process.env.DSH_SNAPSHOT
  if (value === undefined || value === '' || value === 'replay') return 'replay'
  if (value === 'record' || value === 'refresh') return value
  throw new Error(`DSH_SNAPSHOT must be replay, record, or refresh; got ${JSON.stringify(value)}`)
}

/**
 * Compare a normalized golden, or rewrite it under refresh. Refresh is the
 * ONLY writer: a missing golden in replay mode fails with the healing command
 * instead of silently self-bootstrapping.
 * @param goldenPath - the committed ui.expected.md path.
 * @param actual - the stable normalized snapshot.
 * @param mode - the active snapshot mode.
 */
export async function compareOrRefreshGolden(goldenPath: string, actual: string, mode: WebSnapshotMode): Promise<void> {
  const payload = `${actual}\n`
  if (mode === 'refresh') {
    await writeFile(goldenPath, payload)
    return
  }
  if (!existsSync(goldenPath)) {
    throw new Error(`missing golden ${goldenPath} — run DSH_SNAPSHOT=refresh pnpm run test:web to generate it`)
  }
  expect(payload).toBe(await readFile(goldenPath, 'utf8'))
}

