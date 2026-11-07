/** Independent package-manifest owners share Node methods without retaining a retired owner's hooks. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { join } from 'node:path'
import { PackageManifests } from '../../src/package-manifest.ts'

const [root, order] = process.argv.slice(2)
const require = createRequire(import.meta.url)
const addon = require('node-addon-require-builtin')
const binding = addon.requireBuiltin('internal/bootstrap/realm').internalBinding('modules')
const reader = addon.requireBuiltin('internal/modules/package_json_reader')
const originalFs = require('node:fs')
const original = [Module._load, binding.readPackageJSON, binding.getPackageScopeConfig, binding.getPackageType, reader.getNearestParentPackageJSON]
const owners = [new PackageManifests(), new PackageManifests()]
try {
  for (const [i, owner] of owners.entries()) {
    const directory = join(root, String(i))
    mkdirSync(directory)
    const path = join(directory, 'package.json')
    writeFileSync(path, '{"type":"module"}')
    owner.invalidate(path)
  }
  const first = order === 'outer-first' ? 1 : 0
  owners[first].dispose()
  process.stdout.write('first owner retired\n')
  assert.equal(require('node:path').join('a', 'b'), join('a', 'b'))
  assert.equal(reader.getNearestParentPackageJSON(join(root, String(1 - first), 'entry.js')).data.type, 'module')
  if (order === 'reuse-inner') {
    owners[0].invalidate(join(root, '0', 'package.json'))
    owners[0].dispose()
    assert.equal(require('node:fs'), originalFs)
  }
  owners[1 - first].dispose()
  assert.deepEqual([Module._load, binding.readPackageJSON, binding.getPackageScopeConfig, binding.getPackageType, reader.getNearestParentPackageJSON], original)
  process.stdout.write('all hooks restored\n')
} finally { for (const owner of owners) owner.dispose() }
