/** A standalone Gateway needs both release-local package links and the built entries they expose. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ensureGatewayRuntimePackages, gatewayRuntimePackageLinksValid, GATEWAY_RUNTIME_PACKAGES } from './gateway-runtime-packages.ts'

function fixture(links = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-runtime-links-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const packages = GATEWAY_RUNTIME_PACKAGES.map((pkg, index) => {
    const directory = join(root, pkg.directory), entry = join(directory, pkg.entry), name = `@fixture/runtime-${index}`
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name }))
    writeFileSync(entry, 'export {}\n')
    const link = join(root, 'gateway/node_modules', name)
    if (links) {
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(process.platform === 'win32' ? directory : relative(dirname(link), directory), link,
        process.platform === 'win32' ? 'junction' : 'dir')
    }
    return { directory, entry, link }
  })
  return { root, packages }
}

it('requires the document wire runtime in the standalone production package set', () => {
  expect(GATEWAY_RUNTIME_PACKAGES).toContainEqual({ directory: 'packages/attachment/userdoc-gateway', entry: 'lib/protocol.js' })
  expect(GATEWAY_RUNTIME_PACKAGES).toContainEqual({ directory: 'packages/util/values', entry: 'lib/index.js' })
})

it('verifies every complete package and refuses a missing or empty runtime entry behind a valid link', () => {
  const { root, packages } = fixture()
  expect(gatewayRuntimePackageLinksValid(root)).toBe(true)
  for (const pkg of packages) {
    unlinkSync(pkg.entry)
    expect(gatewayRuntimePackageLinksValid(root)).toBe(false)
    mkdirSync(pkg.entry)
    expect(gatewayRuntimePackageLinksValid(root)).toBe(false)
    rmSync(pkg.entry, { recursive: true })
    writeFileSync(pkg.entry, '')
    expect(gatewayRuntimePackageLinksValid(root)).toBe(false)
    writeFileSync(pkg.entry, 'export {}\n')
    expect(gatewayRuntimePackageLinksValid(root)).toBe(true)
  }
})

it('refuses a foreign package link even when its own declared entry exists', () => {
  const { root, packages } = fixture()
  const first = packages[0]!, second = packages[1]!
  unlinkSync(first.link)
  symlinkSync(second.directory, first.link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(gatewayRuntimePackageLinksValid(root)).toBe(false)
  expect(() => { ensureGatewayRuntimePackages(root) }).toThrow(/points to/)
})

it.skipIf(process.platform === 'win32')('creates portable POSIX links and preserves them on repeated assembly', () => {
  const { root, packages } = fixture(false)
  expect(gatewayRuntimePackageLinksValid(root)).toBe(false)
  ensureGatewayRuntimePackages(root); ensureGatewayRuntimePackages(root)
  expect(gatewayRuntimePackageLinksValid(root)).toBe(true)
  for (const pkg of packages) expect(realpathSync(pkg.link)).toBe(realpathSync(pkg.directory))
  const first = packages[0]!
  const manifest = readFileSync(join(first.directory, 'package.json'))
  writeFileSync(join(first.directory, 'package.json'), JSON.stringify({ name: '' }))
  expect(() => { ensureGatewayRuntimePackages(root) }).toThrow(/has no name/)
  writeFileSync(join(first.directory, 'package.json'), manifest)
  unlinkSync(first.entry)
  expect(() => { ensureGatewayRuntimePackages(root) }).toThrow(/incomplete/)
})
