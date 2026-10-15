/** Elevated menu surfaces must pair the translucent fill with its backdrop filter. */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/* The translucent fill is never legible on its own: `--dsw-specific-menu` is
 * 58% opaque in light mode and 45% in dark mode, so elevated surfaces painted
 * with it must blur the content behind via `--dsw-menu-backdrop-filter`, or
 * the underlying text renders through at 42–55% opacity. The gate keys on the
 * fill + elevation-shadow pairing; badge-sized elements reuse the fill as a
 * colour without elevation and stay out of scope. */
const SURFACE_FILL = /background:\s*var\(--dsw-(?:specific-menu|menu-surface-fill)\)/
const ELEVATION = /box-shadow:\s*var\(--dsw-elevation|--dsw-elevation-stroke-color/
const BACKDROP = /backdrop-filter\s*:/

async function stylesheets(dir: string): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'types') continue
      files.push(...await stylesheets(join(dir, entry.name)))
    } else if (entry.name.endsWith('.css')) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

/**
 * Find client stylesheet rules that paint the translucent menu fill on an
 * elevated surface without the backdrop filter.
 * @param root - repository or test-fixture root.
 * @returns deterministic path-qualified violations.
 */
export async function menuSurfaceBackdropViolations(root: string): Promise<string[]> {
  const files = await stylesheets(resolve(root, 'packages/client'))
  const violations: string[] = []
  let surfaces = 0
  for (const file of files) {
    const css = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
    // Leaf blocks only: `{` bodies containing `{` (at-rules) never match, so
    // media-wrapped rules still land here as their own leaf match.
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2] ?? ''
      if (!SURFACE_FILL.test(body) || !ELEVATION.test(body)) continue
      surfaces++
      if (BACKDROP.test(body)) continue
      const selector = (match[1] ?? '').trim().split('\n').pop()?.trim() ?? '?'
      violations.push(
        `${relative(root, file)}: \`${selector}\` pairs the translucent menu fill with an elevation shadow but no backdrop-filter`,
      )
    }
  }
  if (surfaces === 0) {
    throw new Error('verify-menu-surface-backdrop: no elevated menu surfaces found — the corpus or the detection has drifted')
  }
  return violations
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const failures = await menuSurfaceBackdropViolations(root)
  if (failures.length > 0) {
    console.error('verify-menu-surface-backdrop: translucent surface(s) missing backdrop-filter:')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log('verify-menu-surface-backdrop: every elevated menu surface pairs its translucent fill with backdrop-filter.')
  }
}
