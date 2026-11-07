import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { materializeProfilePatch } from '../src/launcher.ts'

it('resolves bare plugins from an explicit workspace while retaining authored relative names and refusing conflicting links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-patch-resolver-'))
  try {
    const authored = join(root, 'authored'), resolver = join(root, 'resolver'), conflicting = join(root, 'conflicting')
    const cwd = join(root, 'runtime'), target = join(root, 'materialized')
    const packageDir = join(resolver, 'node_modules', 'optional-fixture-provider')
    const conflictingPackage = join(conflicting, 'node_modules', 'optional-fixture-provider')
    await Promise.all([authored, target, packageDir, conflictingPackage].map(path => mkdir(path, { recursive: true })))
    const source = join(authored, 'cordis.yml'), resolverSource = join(resolver, 'package.json')
    const original = '- insert:\n    - name: optional-fixture-provider\n    - name: ./relative.mjs\n'
    await Promise.all([
      writeFile(source, original), writeFile(resolverSource, '{"name":"fixture-resolver"}\n'),
      writeFile(join(conflicting, 'package.json'), '{"name":"conflicting-resolver"}\n'),
      writeFile(join(packageDir, 'package.json'), '{"name":"optional-fixture-provider","version":"1.0.0"}\n'),
      writeFile(join(conflictingPackage, 'package.json'), '{"name":"optional-fixture-provider","version":"2.0.0"}\n'),
    ])
    const materialized = materializeProfilePatch(source, cwd, 'sdk', target, 0, resolverSource)
    const link = join(cwd, '.dsh', 'profiles', 'sdk', 'node_modules', 'optional-fixture-provider')
    expect(await realpath(link)).toBe(await realpath(packageDir))
    expect(await readFile(materialized, 'utf8')).toContain(pathToFileURL(join(authored, 'relative.mjs')).href)
    expect(await readFile(source, 'utf8')).toBe(original)
    expect(() => materializeProfilePatch(source, cwd, 'sdk', target, 0, join(conflicting, 'package.json')))
      .toThrow('snapshot profile package optional-fixture-provider resolves to two directories')
    expect(await realpath(link)).toBe(await realpath(packageDir))
  } finally { await rm(root, { recursive: true, force: true }) }
})
