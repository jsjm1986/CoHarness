#!/usr/bin/env node
/**
 * Temporary branch-convergence command: publish current-generation Session
 * fixtures for corpus scenarios still selecting a predecessor. Each selected
 * predecessor file migrates through the released logical chain and lands as the
 * versioned current sibling; historical generations and declared `sessionFormat`
 * retentions stay untouched. Borrowed (`session.source`) manifests are skipped —
 * they follow their owner's selected generation by name.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { sessionFixtureFiles, sessionFixtureName } from '@deepseek-ai/dsh-session-snapshot'

import { isPhysicalSessionFixture, migrateSessionFixtureToCurrent } from './session-fixture-layout.ts'

if (process.argv.length > 2) throw new Error('migrate:session-fixtures-to-current takes no arguments')

const root = resolve(import.meta.dirname, '..')
const snapshotsRoot = join(root, 'snapshots')

/** Scenario directories two levels deep under `snapshots/` that own a manifest. */
function* scenarioDirs(): Generator<string> {
  for (const profile of readdirSync(snapshotsRoot, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue
    for (const entry of readdirSync(join(snapshotsRoot, profile.name), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(snapshotsRoot, profile.name, entry.name, 'snapshot.yml'))) {
        yield join(snapshotsRoot, profile.name, entry.name)
      }
    }
  }
}

const written: string[] = []
const skipped: string[] = []
for (const dir of scenarioDirs()) {
  const rel = dir.slice(root.length + 1)
  const manifest = readFileSync(join(dir, 'snapshot.yml'), 'utf8')
  if (/^sessionFormat:/m.test(manifest) || /^session:/m.test(manifest)) {
    skipped.push(rel)
    continue
  }
  const names = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
  let roles: ReturnType<typeof sessionFixtureFiles>
  try {
    roles = sessionFixtureFiles(names)
  } catch {
    continue
  }
  for (const role of roles) {
    if (role.version >= SESSION_FORMAT_VERSION) continue
    const sourcePath = join(dir, role.name)
    const source = readFileSync(sourcePath, 'utf8')
    if (isPhysicalSessionFixture(`${rel}/${role.name}`)) continue
    const migrated = migrateSessionFixtureToCurrent(source, `${rel}/${role.name}`)
    if (migrated === undefined) continue
    const target = join(dir, sessionFixtureName(role.index, SESSION_FORMAT_VERSION))
    writeFileSync(target, migrated)
    written.push(`${rel}/${role.name} -> ${sessionFixtureName(role.index, SESSION_FORMAT_VERSION)}`)
  }
}
for (const line of written) console.log(line)
console.log(`session fixtures: ${written.length} published at v${SESSION_FORMAT_VERSION}, ${skipped.length} scenarios retained/borrowed`)
