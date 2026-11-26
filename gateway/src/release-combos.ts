/** Optional reader supplied by the installed client-module package in a verified release. */
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Local executable bytes that still require an affirmative owning-node read. */
export interface LocalReleaseCombo {
  readonly sha256: string
  readonly body: Buffer
}

/** Reads trusted release candidates by their exact selector-free request targets. */
export type ReleaseComboReader = (target: string) => Promise<LocalReleaseCombo | undefined>

/**
 * Load the byte producer lazily, through the module package's own release export.
 * @param releaseRoot - canonical immutable release root, or undefined for a source deployment.
 * @returns a reader, or undefined when the deployment has no installed release.
 */
export function releaseComboReader(releaseRoot: string | undefined): ReleaseComboReader | undefined {
  if (releaseRoot === undefined) return undefined
  let reader: Promise<ReleaseComboReader | undefined> | undefined
  const load = async (): Promise<ReleaseComboReader | undefined> => {
    try {
      const directory = join(releaseRoot, 'packages', 'client', 'modules')
      const require = createRequire(join(directory, 'package.json'))
      const entry = await realpath(require.resolve('@deepseek-ai/dsh-client-modules'))
      const inside = relative(directory, entry)
      if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
      const provider = await import(pathToFileURL(entry).href) as {
        openReleaseComboReader?: (root: string) => ReleaseComboReader
      }
      return provider.openReleaseComboReader?.(releaseRoot)
    } catch {
      // Releases lacking the reader continue to use owning-node delivery.
      return undefined
    }
  }
  return async target => {
    if (!target.startsWith('/plugins/combo.js??')) return undefined
    const read = await (reader ??= load())
    return read?.(target)
  }
}
