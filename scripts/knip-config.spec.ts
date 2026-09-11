import type { KnipConfiguration } from 'knip'
import { describe, expect, it } from 'vitest'

import baseConfig from '../knip.json' with { type: 'json' }
import {
  configureGeneratedTypertDependencies,
  GENERATED_TYPERT_FACE_DEPENDENCIES,
  GENERATED_TYPERT_WORKSPACES,
} from '../knip.config.ts'

const typedBaseConfig = baseConfig as KnipConfiguration

describe('generated Typert Knip dependencies', () => {
  it('always ignores zod for generated-Typert workspaces', () => {
    const configured = configureGeneratedTypertDependencies(typedBaseConfig)

    for (const workspace of GENERATED_TYPERT_WORKSPACES) {
      expect(configured.workspaces?.[workspace]?.ignoreDependencies).toContain('zod')
    }
  })

  it('ignores face dependencies when the generated JavaScript face exists', () => {
    const configured = configureGeneratedTypertDependencies(typedBaseConfig, {
      root: '/repo',
      // Match on the basename so the seam holds on Windows, where `resolve`
      // joins with backslashes and a forward-slash suffix would never match.
      fileExists: path =>
        path.endsWith('typert.remote-client.d.ts') ||
        path.endsWith('sessions.d.ts'),
    })

    for (const [workspace, { deps }] of Object.entries(GENERATED_TYPERT_FACE_DEPENDENCIES)) {
      for (const dep of deps) {
        expect(configured.workspaces?.[workspace]?.ignoreDependencies).toContain(dep)
      }
    }
  })

  it('skips face dependencies on a clean checkout without generated faces', () => {
    const configured = configureGeneratedTypertDependencies(typedBaseConfig, {
      root: '/repo',
      fileExists: () => false,
    })

    for (const [workspace, { deps }] of Object.entries(GENERATED_TYPERT_FACE_DEPENDENCIES)) {
      const ignoreDependencies = configured.workspaces?.[workspace]?.ignoreDependencies ?? []
      for (const dep of deps) {
        expect(ignoreDependencies).not.toContain(dep)
      }
    }
  })

  it('does not mutate the checked-in base configuration', () => {
    configureGeneratedTypertDependencies(typedBaseConfig, { root: '/repo' })

    for (const workspace of GENERATED_TYPERT_WORKSPACES) {
      const ignoreDependencies = typedBaseConfig.workspaces?.[workspace]?.ignoreDependencies ?? []
      expect(ignoreDependencies).not.toContain('zod')
    }
    for (const [workspace, { deps }] of Object.entries(GENERATED_TYPERT_FACE_DEPENDENCIES)) {
      const ignoreDependencies = typedBaseConfig.workspaces?.[workspace]?.ignoreDependencies ?? []
      for (const dep of deps) {
        expect(ignoreDependencies).not.toContain(dep)
      }
    }
  })
})
