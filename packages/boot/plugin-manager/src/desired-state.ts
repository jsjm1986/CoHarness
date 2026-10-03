/**
 * Desired-state file protocol shared with the deployment's state store: the
 * profile keeps the managed rows and bundle selection the store saved, and
 * publishes the same fields back after a committed change.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { saveManifest } from './operations.ts'
import type { PluginDesiredEntry, PluginDesiredState } from './types.ts'

/** Keys a management row may carry; anything wider is a user declaration the projection preserves. */
const MANAGED_KEYS = new Set(['id', 'name', 'disabled'])

/**
 * Whether one patch row belongs to the managed set the store owns. Rows are
 * objects whose keys stay within {@link MANAGED_KEYS} with a string id; a
 * wider or differently-keyed row is a hand edit the projection never touches.
 * @param row - one parsed patch row.
 */
function isManagedRow(row: unknown): row is PluginDesiredEntry {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  const record = row as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.disabled === 'boolean'
    && (record.name === undefined || typeof record.name === 'string')
    && Object.keys(record).every(key => MANAGED_KEYS.has(key))
}

/** Parse one patch file's row list; an absent or empty file reads as no rows. */
async function readPatchRows(patchPath: string): Promise<unknown[]> {
  if (!existsSync(patchPath)) return []
  const parsed: unknown = parse(await readFile(patchPath, 'utf8'))
  return Array.isArray(parsed) ? parsed as unknown[] : []
}

/**
 * Read the profile's observed composition: the managed patch rows and the
 * bundle selection, exactly as a state-store publish records them.
 * @param profileDir - the profile's directory.
 * @param patchPath - the profile's own patch file.
 * @returns the composition the files currently express.
 */
export async function readDesiredState(profileDir: string, patchPath: string): Promise<PluginDesiredState> {
  const rows = await readPatchRows(patchPath)
  const entries: PluginDesiredEntry[] = []
  for (const row of rows) {
    if (!isManagedRow(row)) continue
    entries.push({ id: row.id, ...row.name === undefined ? {} : { name: row.name }, disabled: row.disabled })
  }
  const manifest = readProfileManifest('dsh', profileDir)
  return { entries, bundles: [...manifest.dsh?.profile?.bundles ?? []] }
}

/**
 * Replace the profile's managed rows and bundle selection with one desired
 * state, preserving every other declaration and manifest field.
 * @param profileDir - the profile's directory.
 * @param patchPath - the profile's own patch file.
 * @param state - the composition to materialize.
 */
export async function applyDesiredState(profileDir: string, patchPath: string, state: PluginDesiredState): Promise<void> {
  const preserved = (await readPatchRows(patchPath)).filter(row => !isManagedRow(row))
  await writeFileAtomic(patchPath, stringify([...preserved, ...state.entries]), { mode: 0o600 })
  const manifest = readProfileManifest('dsh', profileDir)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...state.bundles] } }
  await saveManifest(profileDir, manifest)
}
