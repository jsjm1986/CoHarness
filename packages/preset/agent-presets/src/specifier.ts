/**
 * Classify one preset composition row's module name before discovery or mount.
 * Relative files resolve from the preset directory; package names resolve from
 * the installed harness; absolute paths and file URLs name one file directly.
 * @module @deepseek-ai/dsh-agent-presets/specifier
 */

import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One composition row's module specifier and its resolution base. */
export type RowSpecifier =
  | { readonly kind: 'builtin'; readonly specifier: string }
  | { readonly kind: 'preset'; readonly specifier: string }
  | { readonly kind: 'file'; readonly specifier: string }
  | { readonly kind: 'package'; readonly specifier: string }

/**
 * Classify a row name using the same rules as the preset mount.
 * @param name - module specifier exactly as written in the composition.
 * @returns classified specifier.
 */
export function classifyRowSpecifier(name: string): RowSpecifier {
  if (name.startsWith('cordis:')) return { kind: 'builtin', specifier: name }
  if (name.startsWith('.')) return { kind: 'preset', specifier: name }
  if (name.startsWith('file:')) return { kind: 'file', specifier: name }
  if (isAbsolute(name)) return { kind: 'file', specifier: pathToFileURL(name).href }
  return { kind: 'package', specifier: name }
}
