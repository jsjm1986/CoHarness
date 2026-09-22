/**
 * Fiber service-state helpers for `cordis_inspect_self`: which services a mounted
 * fiber subtree provides, and which `inject` declarations are still waiting on a
 * provider.
 * @module @deepseek-ai/dsh-tool-cordis/inspect
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'

/** The live service registrations, read from the reflect store. */
function liveImpls(ctx: Context): { name: string; fiber: Fiber }[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key])
    .filter((impl): impl is NonNullable<typeof impl> => impl !== undefined)
}

/**
 * Whether a fiber is `root` itself or mounted anywhere inside `root`'s subtree.
 * @param fiber - the fiber to locate.
 * @param root - the subtree root to test against.
 * @returns true when `fiber` belongs to that subtree.
 */
export function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/**
 * Service names provided by one mount's fiber subtree.
 * @param ctx - the runtime whose service registrations are inspected.
 * @param fiber - the root of the mounted fiber subtree.
 * @returns the provided service names in lexical order.
 */
export function providedServices(ctx: Context, fiber: Fiber): string[] {
  return liveImpls(ctx)
    .filter(impl => withinFiber(impl.fiber, fiber))
    .map(impl => impl.name)
    .sort()
}

/**
 * Services a fiber declared in `inject` that do not exist yet — a settled fiber
 * that is not active is waiting on exactly these (legal cordis semantics: it
 * activates when the service appears).
 * @param ctx - the context to resolve service existence against.
 * @param fiber - the fiber whose `inject` declarations are checked.
 * @returns the missing service names, in declaration order.
 */
export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}
