/**
 * Mechanical guard for the coverage-baseline roster: every entry must name an
 * existing measured source file exactly once, so a moved or deleted source
 * cannot keep a stale per-file exclusion alive, and a glob cannot widen the
 * roster beyond the files the first gate run actually reported.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coverageBaselineFiles } from './coverage-baseline.ts'

const root = resolve(import.meta.dirname, '..')

describe('coverage-baseline roster', () => {
  it('names only existing files under a package src tree, with no globs', () => {
    for (const file of coverageBaselineFiles) {
      expect(file, `${file} must be a literal packages/<group>/<pkg>/src path`)
        .toMatch(/^packages\/[^/*]+\/[^/*]+\/src\/[^*?{}[\]]+\.tsx?$/)
      expect(existsSync(resolve(root, file)), `${file} no longer exists; delete its roster line`).toBe(true)
    }
  })

  it('lists every file once', () => {
    expect(new Set(coverageBaselineFiles).size).toBe(coverageBaselineFiles.length)
  })
})
