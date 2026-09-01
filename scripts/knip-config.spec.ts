import { resolve } from 'node:path'

import type { KnipConfiguration } from 'knip'
import { describe, expect, it } from 'vitest'

import baseConfig from '../knip.json' with { type: 'json' }
import {
  configureGeneratedTypertDependencies,
  GENERATED_TYPERT_WORKSPACES,
} from '../knip.config.ts'

const typedBaseConfig = baseConfig as KnipConfiguration

describe('generated Typert Knip dependencies', () => {
  it('ignores zod only when a clean checkout has no generated JavaScript face', () => {
    const configured = configureGeneratedTypertDependencies(typedBaseConfig, {
      root: '/repo',
      fileExists: () => false,
    })

    for (const workspace of GENERATED_TYPERT_WORKSPACES) {
      expect(configured.workspaces?.[workspace]?.ignoreDependencies).toContain('zod')
    }
  })

  it('lets Knip observe zod when either generated JavaScript face exists', () => {
    const hostFace = resolve(
      '/repo',
      GENERATED_TYPERT_WORKSPACES[0],
      'lib/typert.host.js',
    )
    const configured = configureGeneratedTypertDependencies(typedBaseConfig, {
      root: '/repo',
      fileExists: path => path === hostFace,
    })

    expect(
      configured.workspaces?.[GENERATED_TYPERT_WORKSPACES[0]]?.ignoreDependencies ?? [],
    ).not.toContain('zod')
    for (const workspace of GENERATED_TYPERT_WORKSPACES.slice(1)) {
      expect(configured.workspaces?.[workspace]?.ignoreDependencies).toContain('zod')
    }
  })

  it('does not mutate the checked-in base configuration', () => {
    configureGeneratedTypertDependencies(typedBaseConfig, {
      root: '/repo',
      fileExists: () => false,
    })

    for (const workspace of GENERATED_TYPERT_WORKSPACES) {
      expect(typedBaseConfig.workspaces?.[workspace]?.ignoreDependencies).toBeUndefined()
    }
  })
})
