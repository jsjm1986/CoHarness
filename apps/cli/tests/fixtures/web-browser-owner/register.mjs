/** Private opener and optional complete old Web bundle for the CLI ownership regression. */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const opener = new URL('./open.mjs', import.meta.url).href
const old = process.env.DSH_WEB_OWNER_OLD_ARTIFACT
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'open') return { shortCircuit: true, url: opener }
    const resolved = nextResolve(specifier, context)
    if (old !== undefined && new URL(resolved.url).pathname.endsWith('/packages/bundle/web-app/lib/index.js')) {
      return { shortCircuit: true, url: pathToFileURL(join(old, 'lib/index.js')).href }
    }
    return resolved
  },
})
