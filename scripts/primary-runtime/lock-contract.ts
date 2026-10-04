/** Lock-file invariants asserted by the specs of each primary-runtime prepare variant. */

import { basename } from 'node:path'
import { expect, it } from 'vitest'

/** Wheel/distribution fields every runtime lock file carries. */
interface RuntimeLock {
  readonly targets: Readonly<Record<string, { readonly wheels: readonly { readonly url: string }[] }>>
  readonly wheels: readonly { readonly url: string }[]
  readonly pythonPackages: Record<string, string>
}

interface DigestLock {
  targets: Record<string, { wheels: { url: string; sha256: string }[] }>
  wheels: { url: string; sha256: string }[]
  pythonPackages: Record<string, string>
}

/**
 * Assert one target's locked wheel list equals the declared Python distributions.
 * @param lock - Runtime lock under test.
 * @param artifact - Locked artifact of the target being checked.
 */
export function expectLockedDistributions(lock: RuntimeLock, artifact: { readonly wheels: readonly { readonly url: string }[] }): void {
  const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/gu, '-')
  const distributions = [...artifact.wheels, ...lock.wheels].map(({ url }) => {
    const [name = '', version] = basename(new URL(url).pathname).split('-')
    return [normalize(name), version] as const
  })
  const declared = Object.entries(lock.pythonPackages).map(([name, version]) => [normalize(name), version] as const)
  expect(new Set(distributions.map(([name]) => name)).size).toBe(distributions.length)
  expect(new Set(declared.map(([name]) => name)).size).toBe(declared.length)
  expect(Object.fromEntries(distributions)).toEqual(Object.fromEntries(declared))
}

/**
 * Assert edits inside one target's lock change only that target's payload digest.
 * @param lock - Runtime lock under test.
 * @param payloadDigest - Digest implementation of the prepare variant under test.
 */
export function expectPayloadDigestIsolation<T extends DigestLock>(
  lock: T,
  payloadDigest: (target: never, runtimeLock: T, pnpmVersion: string) => string,
): void {
  const digest = payloadDigest as (target: string, runtimeLock: T, pnpmVersion: string) => string
  const changed = structuredClone(lock)
  const targetWheel = changed.targets['win-x64']?.wheels[0]
  if (targetWheel === undefined) throw new Error('lock fixture provides no win-x64 wheel')
  targetWheel.sha256 = 'a'.repeat(64)
  expect(digest('mac-arm64', changed, '11.7.0')).toBe(digest('mac-arm64', lock, '11.7.0'))
  expect(digest('win-x64', changed, '11.7.0')).not.toBe(digest('win-x64', lock, '11.7.0'))
}

/**
 * Assert shared wheels, declared versions and the package manager all invalidate the digest.
 * @param lock - Runtime lock under test.
 * @param payloadDigest - Digest implementation of the prepare variant under test.
 */
export function expectPayloadDigestInvalidation<T extends DigestLock>(
  lock: T,
  payloadDigest: (target: never, runtimeLock: T, pnpmVersion: string) => string,
): void {
  const digest = payloadDigest as (target: string, runtimeLock: T, pnpmVersion: string) => string
  const wheel = structuredClone(lock), distribution = structuredClone(lock)
  const sharedWheel = wheel.wheels[0]
  if (sharedWheel === undefined) throw new Error('lock fixture provides no shared wheel')
  sharedWheel.sha256 = 'a'.repeat(64)
  distribution.pythonPackages['python-docx'] = '1.2.1'
  const original = digest('mac-arm64', lock, '11.7.0')
  expect(digest('mac-arm64', wheel, '11.7.0')).not.toBe(original)
  expect(digest('mac-arm64', distribution, '11.7.0')).not.toBe(original)
  expect(digest('mac-arm64', lock, '11.7.1')).not.toBe(original)
}

/**
 * Register the lock/digest contract tests one prepare variant's spec must satisfy.
 * @param lock - Runtime lock file under test.
 * @param payloadDigest - Digest implementation of the prepare variant under test.
 */
export function declareRuntimeLockContract<T extends DigestLock>(
  lock: T,
  payloadDigest: (target: never, runtimeLock: T, pnpmVersion: string) => string,
): void {
  it.each(Object.entries(lock.targets))('records every locked wheel distribution and version for %s', (_target, artifact) => {
    expectLockedDistributions(lock, artifact)
  })
  it('keeps a target payload identity independent of other target archives', () => {
    expectPayloadDigestIsolation(lock, payloadDigest)
  })
  it('invalidates payload identity for shared wheels, package versions and package-manager changes', () => {
    expectPayloadDigestInvalidation(lock, payloadDigest)
  })
}
