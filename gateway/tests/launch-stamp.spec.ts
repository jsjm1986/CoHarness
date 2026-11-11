import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testConfig } from './test-config.ts'
import { computeLaunchStamps, policyPatchText } from '../src/launch-stamp.ts'
import { INSTANCE_PROFILE } from '../src/instances.ts'
import type { GatewayConfig } from '../src/config.ts'

const roots: string[] = []
const fixture = (): { root: string; cfg: GatewayConfig } => {
  const root = mkdtempSync(join(tmpdir(), 'hgw-stamp-'))
  roots.push(root)
  // The guard and governance packages launch stamping digests.
  for (const name of ['dsh-directory-guard', 'dsh-model-governance', 'dsh-steward-tools']) {
    const dir = join(root, 'plugins', name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}` }))
    writeFileSync(join(dir, 'lib', 'index.js'), `export const plugin = '${name}'\n`)
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert: []\n`)
  }
  writeFileSync(join(root, 'plugins', 'dsh-directory-guard', 'cordis.admin.patch.yml'), '- id: permission\n')
  mkdirSync(join(root, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(root, 'apps', 'cli', 'lib', 'bin.js'), 'void 0\n')
  const cfg = testConfig(root, {
    HGW_DSH_REPO_ROOT: root,
    HGW_STEWARD_TOOLS_PACKAGE: join(root, 'plugins', 'dsh-steward-tools'),
  })
  return { root, cfg }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('computeLaunchStamps', () => {
  it('mints a deterministic set for the same build and different sets for different roles', () => {
    const { cfg } = fixture()
    const first = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    const second = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    expect(first.stamps).toEqual(second.stamps)
    const member = first.stampFor({ admin: false, kind: 'user', steward: false })
    const admin = first.stampFor({ admin: true, kind: 'user', steward: false })
    const steward = first.stampFor({ admin: false, kind: 'project', steward: true })
    expect(member).not.toBe(admin)
    expect(member).not.toBe(steward)
    expect(first.stamps.has(member)).toBe(true)
    expect(first.stamps.has(admin)).toBe(true)
    expect(first.stamps.has(steward)).toBe(true)
    expect(first.stamps.has('foreign-stamp')).toBe(false)
  })

  it('changes every stamp when code under the closure root changes', () => {
    const { root, cfg } = fixture()
    const before = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    mkdirSync(join(root, 'packages', 'core', 'session', 'lib'), { recursive: true })
    writeFileSync(join(root, 'packages', 'core', 'session', 'lib', 'index.js'), 'export const changed = true\n')
    const after = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    for (const stamp of before.stamps) expect(after.stamps.has(stamp)).toBe(false)
  })

  it('mints the same set for identical content at a different path', () => {
    const { root, cfg } = fixture()
    const moved = mkdtempSync(join(tmpdir(), 'hgw-stamp-moved-'))
    roots.push(moved)
    cpSync(root, moved, { recursive: true })
    const first = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    const second = computeLaunchStamps({ ...cfg, dshRepoRoot: moved }, '', INSTANCE_PROFILE)
    expect(second.stamps).toEqual(first.stamps)
  })

  it('fails the whole set when the governance package is unreadable', () => {
    const { cfg } = fixture()
    const broken = { ...cfg, modelGovernancePackage: join(cfg.modelGovernancePackage, 'missing') }
    expect(() => computeLaunchStamps(broken, '', INSTANCE_PROFILE)).toThrow('model-governance package is incomplete')
  })
})

describe('policyPatchText', () => {
  it('embeds the administrator guard patch only for admin variants', () => {
    const { cfg } = fixture()
    const member = policyPatchText(cfg, { admin: false, kind: 'user', steward: false })
    const admin = policyPatchText(cfg, { admin: true, kind: 'user', steward: false })
    expect(member).not.toContain('id: permission')
    expect(admin).toContain('id: permission')
  })

  it('embeds the steward tools patch only for steward variants', () => {
    const { cfg } = fixture()
    const standard = policyPatchText(cfg, { admin: false, kind: 'project', steward: false })
    const steward = policyPatchText(cfg, { admin: false, kind: 'project', steward: true })
    expect(standard).not.toContain("name: '@deepseek-ai/dsh-steward-tools'")
    expect(standard).toContain('collaboration-gateway')
    expect(steward).toContain('collaboration-gateway')
  })
})
