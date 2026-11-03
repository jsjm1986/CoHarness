/** Scoped layers for Node package methods shared by overlapping HMR instances. */
const PACKAGE_METHOD_LAYER = Symbol.for('@deepseek-ai/dsh-hmr/package-method-layer')
type PackageMethod = (...args: never[]) => unknown
interface PackageMethodLayer {
  active: boolean
  previous: PackageMethod
}
type LayeredPackageMethod = PackageMethod & { [PACKAGE_METHOD_LAYER]?: PackageMethodLayer }

function activePredecessor(method: PackageMethod): PackageMethod {
  let current = method
  for (;;) {
    const layer = (current as LayeredPackageMethod)[PACKAGE_METHOD_LAYER]
    if (layer === undefined || layer.active) return current
    current = layer.previous
  }
}

/**
 * Capture current methods and install independently revocable layers.
 * @param target - Node method object shared by the owners.
 * @returns captured predecessors and layer installation with an idempotent disposer.
 */
export function createReplaceHelper<T extends { [K in keyof T]: PackageMethod }>(target: T): {
  rawImpl: T
  replaceMethod<K extends keyof T>(key: K, replacement: T[K]): () => void
} {
  const rawImpl = { ...target }
  return {
    rawImpl,
    replaceMethod<K extends keyof T>(key: K, replacement: T[K]): () => void {
      const layer: PackageMethodLayer = { active: true, previous: rawImpl[key] }
      const wrapped = function (this: unknown, ...args: never[]): unknown {
        return Reflect.apply(layer.active ? replacement : activePredecessor(layer.previous), this, args)
      } as T[K]
      Object.defineProperty(wrapped, PACKAGE_METHOD_LAYER, { value: layer })
      target[key] = wrapped
      return () => {
        layer.active = false
        if (target[key] === wrapped) target[key] = activePredecessor(layer.previous) as T[K]
      }
    },
  }
}
