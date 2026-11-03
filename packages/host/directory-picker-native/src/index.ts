/**
 * Native backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `native` capability, opening one native OS chooser on the host
 * display per pick (macOS a scripted AppKit panel that installs the standard
 * Edit menu before opening `NSOpenPanel`, Linux Zenity with a KDialog fallback;
 * Windows opens the modern `IFileOpenDialog` in a spawned child process — a
 * koffi-driven COM conversation on the child's main thread, preceded by a
 * synthesized Alt press so the dialog activates as foreground even when a
 * background host spawned the child). Only viable when
 * the operator sits at the host's screen; remote deployments compose the
 * browse backend instead. Provider withdrawal cancels accepted picks, awaits
 * their promises, and refuses calls through retained capability objects.
 * @module @deepseek-ai/dsh-host-directory-picker-native
 */

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type { Context } from '@deepseek-ai/cordis'
import { pickNativeDirectory } from './native-picker.ts'

export type { DirectoryPickerInternals, DirectoryPickerRunner } from './native-picker.ts'
export { pickNativeDirectory } from './native-picker.ts'

/** The `ctx.directoryPicker` native implementation (stable capability object per service life). */
export default class NativeDirectoryPicker extends DirectoryPicker {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<string | null>>()
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => this.pick(signal),
  }

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('native directory picker disposed'))
      await Promise.allSettled(this.pending)
    }, 'native directory picker: accepted operations')
  }

  private async pick(signal: AbortSignal): Promise<string | null> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    const operation = pickNativeDirectory(lifetime)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
