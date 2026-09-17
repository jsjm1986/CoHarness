/**
 * Adaptive chooser of the directory-picker seam: resolves the host's
 * situation once at boot (bind host, SSH launch, display session, Linux
 * chooser binary) and mounts the matching interaction — `native` or `browse`
 * — as real Loader entries in the in-memory root tree. Each interaction is a
 * pair: the Host backend serving the seam capability and the client surface
 * occupying ui-workspace's directory-flow holes. Both arrive as ordinary
 * entries, so the surface is discovered exactly as a config-row's would be
 * and one resolved choice still swaps both faces; pinning an interaction
 * remains composing that pair directly instead of this row.
 * @module @deepseek-ai/dsh-host-directory-picker-auto
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
// Empty type import carries the `webServer` Context merge for the read below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { canExecute, hasLinuxChooserBinary } from './probe.ts'
import type { DirectoryPickerBackendKind } from './resolve.ts'
import { resolveDirectoryPickerBackend } from './resolve.ts'

export { canExecute, hasLinuxChooserBinary } from './probe.ts'
export type { DirectoryPickerBackendKind, DirectoryPickerEnv, DirectoryPickerHostFacts } from './resolve.ts'
export { resolveDirectoryPickerBackend } from './resolve.ts'

/** Cordis plugin name. */
export const name = 'directory-picker-auto'
/** Required services: the effective bind host (`webServer`) and the entry tree the backend mounts into (`loader`). */
export const inject = ['webServer', 'loader']

/**
 * Host backend package per resolved kind — fixed composition vocabulary, not a
 * tunable. Exported because the reference is a runtime string the static
 * config gate cannot see in a yml row: `verify-cordis-config` requires every
 * app composing this chooser to declare both values as dependencies.
 */
export const BACKEND_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-host-directory-picker-native',
  browse: '@deepseek-ai/dsh-host-directory-picker-browse',
}

/**
 * Client surface package per resolved kind, mounted with its backend so one
 * resolved interaction still composes both faces. Declared as dependencies by
 * every composing app for the same reason as {@link BACKEND_PACKAGES}. Only the
 * specifier is referenced here — the packages belong to the Client program, so
 * no import of them exists on this side and knip needs them ignored for this
 * workspace.
 */
export const SURFACE_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-client-ui-directory-picker-native',
  browse: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
}

/**
 * Resolve the interaction from one boot-time sample and mount its backend and
 * surface as Loader entries. Import or activation failure fails the chooser
 * and removes both entries. The Loader logs the original import error; the
 * chooser reports the missing entry fiber without retrying the import.
 * Its disposer waits for both fibers to finish teardown, including entries
 * already removed from the Loader tree.
 * @param ctx - cordis context carrying the injected `webServer` and `loader`.
 */
export async function apply(ctx: Context): Promise<void> {
  const backend = resolveDirectoryPickerBackend({
    bindHost: ctx.webServer.host,
    platform: process.platform,
    env: process.env,
    linuxChooser: hasLinuxChooserBinary(process.env.PATH, canExecute),
  })
  await ctx.effect(async () => {
    // Root-tree create: the Loader root is in-memory (write() is a no-op), so
    // the mounted rows can never be persisted back into a config file. The
    // backend lands first: the surface's browser half drives the capability
    // the backend registers.
    const loader = ctx.loader
    const entries: { id: string; entry?: Entry }[] = []
    const unmount = async () => {
      for (const { id, entry } of [...entries].reverse()) {
        const fiber = entry?.fiber
        if (loader.store[id] === entry && entry) loader.remove(id)
        // remove() only requests disposal. The retained entry also owns teardown
        // after a tree stop has deleted its store row; repeated dispose() is not a join.
        await fiber?.dispose()
        while (fiber?.inertia) await fiber.inertia
      }
    }
    try {
      for (const name of [BACKEND_PACKAGES[backend], SURFACE_PACKAGES[backend]]) {
        const options = { name }
        const owned: { id: string; entry?: Entry } = { id: loader.ensureId(options) }
        entries.push(owned)
        try {
          await loader.create(options)
        } finally {
          const entry = loader.store[owned.id]
          if (entry) owned.entry = entry
        }
        if (!owned.entry?.fiber) {
          throw new Error(`directory-picker-auto: entry did not start: ${name}`)
        }
        // Only join our own fiber: loader.await() would also wait for this apply().
        await owned.entry.fiber.await()
      }
    } catch (cause) {
      // Setup owns the entries it created until it returns the disposer: leaving
      // the backend mounted would make a retry collide with its own
      // directoryPicker registration.
      await unmount()
      throw cause
    }
    return unmount
  }, 'directory-picker-auto: interaction entries')
}
