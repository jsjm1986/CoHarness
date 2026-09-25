import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { snapshotRecordPreflight, webLiveRequested } from './scripts/snapshot-preflight.ts'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Web browser lane: real host entry points, built-client interaction snapshots,
// and replayed keyless e2e scenarios outside the unit/e2e includes. Linux PR CI
// pins DSH_SNAPSHOT=replay and compares committed goldens; record/refresh remain
// explicit local workflows. Live verification requires an explicit lane and key.
const live = webLiveRequested()
if (process.env.DSH_SNAPSHOT === 'record' || live) snapshotRecordPreflight()

export default defineConfig({
  // Same resolution note as vitest.config.ts: the tsconfig.base.json paths
  // facade has no include (match-all), so apps/web/tests resolves bare
  // workspace imports to source like every other lane.
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
    standardDecoratorPlugin(),
  ],
  test: {
    execArgv: vitestExecArgv,
    include: [
      'apps/web/tests/**/*.e2e.ts',
      'apps/web/tests/**/*.snapshot.ts',
    ],
    ...(live ? { testNamePattern: 'web smoke \\(real host, real key\\)' } : {}),
    // Local and record runs stay serial. CI runs workspace-mutating HMR and
    // dynamic Cordis lifecycle coverage before parallelizing the remaining files.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
