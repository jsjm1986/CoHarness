/** Select the actual source or built recorder for the SDK recovery composition. */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
if (mode !== 'src' && mode !== 'lib') throw new Error('Review recovery requires src or lib')
const old = process.env.DSH_REVIEW_RECOVERY_OLD_PACKAGE
const recorder = await import(old === undefined
  ? new URL(`../../../${mode}/index.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url).href
  : pathToFileURL(join(old, 'lib/index.js')).href)
export const name = 'review-recovery-recorder'
export const Config = recorder.Config
export const inject = [...recorder.inject, 'workspaceReviewRecoveryReady']
export const apply = recorder.apply
