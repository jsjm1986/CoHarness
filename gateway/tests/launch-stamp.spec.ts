import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testConfig } from './test-config.ts'
import { computeLaunchStamps, policyPatchText } from '../src/launch-stamp.ts'
import { readReleaseRuntimeDigest, verifyReleaseRuntimeDigest, writeReleaseRuntimeDigest } from '../src/runtime-dependency-fingerprint.ts'
import { INSTANCE_PROFILE } from '../src/instances.ts'
import type { GatewayConfig } from '../src/config.ts'

const roots: string[] = []
const dep = (root: string): string => join(root, 'apps', 'cli', 'node_modules', '@fixture', 'runtime')
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
  writeFileSync(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', files: ['lib'], dependencies: { '@fixture/runtime': '1.0.0' },
  }))
  mkdirSync(join(dep(root), 'lib'), { recursive: true })
  writeFileSync(join(dep(root), 'package.json'), JSON.stringify({ name: '@fixture/runtime', exports: './lib/index.js', files: ['lib'] }))
  writeFileSync(join(dep(root), 'lib', 'index.js'), 'export const value = 1\n')
  const cfg = testConfig(root, {
    HGW_DSH_REPO_ROOT: root,
    HGW_STEWARD_TOOLS_PACKAGE: join(root, 'plugins', 'dsh-steward-tools'),
  })
  cfg.dshCommand = [process.execPath, join(root, 'apps', 'cli', 'lib', 'bin.js'), 'web', '--no-open', '--port', '{port}']
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

  it('changes every stamp when a resolved runtime dependency changes', () => {
    const { root, cfg } = fixture()
    const before = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    writeFileSync(join(dep(root), 'lib', 'index.js'), 'export const value = 2\n')
    const after = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    for (const stamp of before.stamps) expect(after.stamps.has(stamp)).toBe(false)
  })

  it('keeps launch identity after documentation, declarations and unrelated workspaces change', () => {
    const { root, cfg } = fixture()
    const before = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    writeFileSync(join(root, 'apps', 'cli', 'README.md'), '# changed documentation\n')
    writeFileSync(join(dep(root), 'lib', 'index.d.ts'), 'export declare const value: number\n')
    mkdirSync(join(root, 'packages', 'unrelated', 'lib'), { recursive: true })
    writeFileSync(join(root, 'packages', 'unrelated', 'lib', 'index.js'), 'void 1\n')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '# unrelated dependency changed\n')
    expect(computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps).toEqual(before.stamps)
  })

  it('captures source entry changes when the managed CLI launches from source', () => {
    const { root, cfg } = fixture()
    const entry = join(root, 'apps', 'cli', 'src', 'bin.ts')
    mkdirSync(join(dep(root), 'src'), { recursive: true })
    mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(entry, 'void 0\n')
    cfg.dshCommand[1] = entry
    const before = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    writeFileSync(join(dep(root), 'src', 'index.ts'), 'export const value = 3\n')
    expect(computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps).not.toEqual(before.stamps)
  })

  it('refuses to mint a release stamp for a dependency linked into another release', () => {
    const { root, cfg } = fixture()
    const web = join(root, 'apps', 'web')
    mkdirSync(web)
    writeFileSync(join(web, 'package.json'), '{}')
    const release = { ...cfg, releaseRoot: root }
    expect(computeLaunchStamps(release, '', INSTANCE_PROFILE).stamps.size).toBeGreaterThan(0)
    const foreign = mkdtempSync(join(tmpdir(), 'hgw-stamp-foreign-'))
    roots.push(foreign)
    cpSync(dep(root), foreign, { recursive: true })
    rmSync(dep(root), { recursive: true })
    symlinkSync(foreign, dep(root), 'junction')
    expect(() => computeLaunchStamps(release, '', INSTANCE_PROFILE)).toThrow('Runtime dependency resolves outside the release')
  })

  it('verifies the recorded fingerprint against the staged Runtime files and their resolved dependency bytes', () => {
    const { root, cfg } = fixture()
    const web = join(root, 'apps', 'web')
    mkdirSync(web)
    writeFileSync(join(web, 'package.json'), '{}')
    mkdirSync(join(root, 'gateway', 'lib'), { recursive: true })
    writeReleaseRuntimeDigest(root)
    expect(readReleaseRuntimeDigest(root)).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => verifyReleaseRuntimeDigest(root)).not.toThrow()
    expect(computeLaunchStamps({ ...cfg, releaseRoot: root }, '', INSTANCE_PROFILE).stamps.size).toBeGreaterThan(0)
    writeFileSync(join(root, 'apps', 'cli', 'README.md'), '# new documentation\n')
    expect(() => verifyReleaseRuntimeDigest(root)).not.toThrow()
    writeFileSync(join(dep(root), 'lib', 'index.js'), 'export const value = 4\n')
    expect(() => verifyReleaseRuntimeDigest(root)).toThrow('Release Runtime dependencies differ from the built fingerprint')
  })

  it('mints the same set for identical content at a different path', () => {
    const { root, cfg } = fixture()
    const moved = mkdtempSync(join(tmpdir(), 'hgw-stamp-moved-'))
    roots.push(moved)
    cpSync(root, moved, { recursive: true })
    const first = computeLaunchStamps(cfg, '', INSTANCE_PROFILE)
    const second = computeLaunchStamps({ ...cfg, dshRepoRoot: moved,
      dshCommand: cfg.dshCommand.map(argument => argument.replace(root, moved)) }, '', INSTANCE_PROFILE)
    expect(second.stamps).toEqual(first.stamps)
  })

  it('fails the whole set when the governance package is unreadable', () => {
    const { cfg } = fixture()
    const broken = { ...cfg, modelGovernancePackage: join(cfg.modelGovernancePackage, 'missing') }
    expect(() => computeLaunchStamps(broken, '', INSTANCE_PROFILE)).toThrow('model-governance package is incomplete')
  })
})

describe('policyPatchText', () => {
  it('projects the first-page limit through the managed Connection plugin', () => {
    const { cfg } = fixture()
    const variant = { admin: false, kind: 'user', steward: false } as const
    expect(policyPatchText(cfg, variant)).not.toContain('preparedHistoryMessages:')
    expect(policyPatchText({ ...cfg, runtimePreparedHistoryMessages: 2 }, variant))
      .toContain('    preparedHistoryMessages: 2\n    recovery:')
  })
  it('disables only VNC and its stream without exposing private state or changing desktop metadata', () => {
    const { cfg } = fixture()
    const variant = { admin: false, kind: 'user', steward: false } as const
    const enabled = policyPatchText(cfg, variant)
    const disabled = policyPatchText({ ...cfg, remoteDesktopEnabled: false }, variant)
    expect(enabled).toContain(`grantsFile: ${JSON.stringify(join(cfg.remoteDesktopDir, 'grants.jsonl'))}`)
    expect(enabled).not.toContain('- id: remote-desktop-vnc\n  disabled: true')
    expect(disabled).toContain('- id: remote-desktop-vnc\n  disabled: true\n- id: remote-desktop-stream\n  disabled: true')
    expect(disabled).not.toContain(cfg.remoteDesktopDir)
    expect(disabled).not.toContain('- id: remote-desktop-controller')
    expect(disabled).toContain("name: '@deepseek-ai/dsh-gateway-execution/desktop-availability'")
    const enabledStamp = computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stampFor(variant)
    expect(computeLaunchStamps({ ...cfg, remoteDesktopEnabled: true }, '', INSTANCE_PROFILE).stampFor(variant)).toBe(enabledStamp)
    expect(computeLaunchStamps({ ...cfg, remoteDesktopEnabled: false }, '', INSTANCE_PROFILE).stampFor(variant)).not.toBe(enabledStamp)
  })

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
