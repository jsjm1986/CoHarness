/** Offline plugin display metadata: locale dictionaries resolved without starting the runtime. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A localized field always carries `en` — the display fallback, mirroring `readPluginMeta`. */
export type PluginStateText = { en: string } & Record<string, string>

/** Localized plugin display text for one state row, keyed by language id. */
export interface PluginStateMeta {
  title?: PluginStateText
  description?: PluginStateText
}

/** Per-row display metadata attached to the `plugins/state` response. */
export interface PluginStateMetaIndex {
  entries: Record<string, PluginStateMeta>
  bundles: Record<string, PluginStateMeta>
}

/** The package name one module specifier selects, without any subpath. */
function barePackageName(specifier: string): string | undefined {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0] === '' ? undefined : parts[0]
}

function localeMeta(dir: string): PluginStateMeta | undefined {
  const localeDir = join(dir, 'locale')
  if (!existsSync(localeDir)) return undefined
  const meta: { title: Record<string, string>; description: Record<string, string> } = { title: {}, description: {} }
  for (const file of readdirSync(localeDir)) {
    if (!file.endsWith('.json')) continue
    const language = file.slice(0, -5)
    try {
      const parsed = JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as {
        meta?: { title?: unknown; description?: unknown }
      }
      if (typeof parsed.meta?.title === 'string') meta.title[language] = parsed.meta.title
      if (typeof parsed.meta?.description === 'string') meta.description[language] = parsed.meta.description
    } catch { /* An unreadable dictionary loses that language only. */ }
  }
  const withEnglish = (fields: Record<string, string>): PluginStateText | undefined => {
    const entries = Object.entries(fields)
    const first = entries[0]
    if (first === undefined) return undefined
    return { en: fields.en ?? first[1], ...fields }
  }
  const title = withEnglish(meta.title)
  const description = withEnglish(meta.description)
  if (title === undefined && description === undefined) return undefined
  return { ...title === undefined ? {} : { title }, ...description === undefined ? {} : { description } }
}

/** Index package name to directory under one workspace root, one nesting level deep. */
function indexRoot(root: string, index: Map<string, string>): void {
  let groups: string[]
  try {
    groups = readdirSync(root)
  } catch {
    return
  }
  for (const group of groups) {
    for (const dir of [join(root, group)]) {
      let manifest: string
      try {
        manifest = readFileSync(join(dir, 'package.json'), 'utf8')
      } catch {
        for (const leaf of readdirSync(dir)) {
          const pkgDir = join(dir, leaf)
          try {
            const name = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: string }).name
            if (typeof name === 'string') index.set(name, pkgDir)
          } catch { /* Not a package directory. */ }
        }
        continue
      }
      const name = (JSON.parse(manifest) as { name?: string }).name
      if (typeof name === 'string') index.set(name, dir)
    }
  }
}

/**
 * Resolve display metadata for state entries whose live inventory is absent —
 * stopped instances have no `listPlugins` to title their rows. Searches the
 * profile's own `node_modules` first (materialized policy packages and
 * user-installed plugins), then the deployment's workspace packages.
 */
export class PluginStateMetaResolver {
  private workspaceIndex: Map<string, string> | undefined

  /**
   * @param releaseRoots - directories holding workspace package trees
   *   (`packages/<group>/<pkg>`, `plugins/<pkg>`, `vendor/<pkg>`); the index is
   *   built lazily once — a release directory is immutable for the process.
   */
  constructor(private readonly releaseRoots: readonly string[]) {}

  /** Read the localized display text for one package specifier, or undefined when none exists. */
  metaOf(specifier: string | undefined, profileDir: string): PluginStateMeta | undefined {
    if (specifier === undefined) return undefined
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const installed = join(profileDir, 'node_modules', name)
    if (existsSync(installed)) {
      const meta = localeMeta(installed)
      if (meta !== undefined) return meta
    }
    this.workspaceIndex ??= this.buildIndex()
    const dir = this.workspaceIndex.get(name)
    return dir === undefined ? undefined : localeMeta(dir)
  }

  private buildIndex(): Map<string, string> {
    const index = new Map<string, string>()
    for (const root of this.releaseRoots) indexRoot(root, index)
    return index
  }
}
