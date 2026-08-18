import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import {
  assertProjectImportPathAllowed,
  listProjectDirectories,
} from '../src/project-directories.ts'

function localFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-directories-'))
  const browse = join(root, 'browse')
  const gatewayData = join(root, 'gateway-data')
  const usersRoot = join(root, 'users')
  const projectRuntimesRoot = join(root, 'project-runtimes')
  const projectsRoot = join(root, 'projects', 'admin')
  const userProjectsRoot = join(root, 'projects', 'user-projects')
  const gatewayDir = join(root, 'gateway-code')
  const dshRepoRoot = join(root, 'release-code')
  mkdirSync(browse, { recursive: true })
  for (const path of [usersRoot, projectRuntimesRoot, projectsRoot, userProjectsRoot, gatewayDir, dshRepoRoot]) {
    mkdirSync(path, { recursive: true })
  }
  const cfg = loadConfig({
    HGW_USERS_ROOT: usersRoot,
    HGW_STATE_ROOT: gatewayData,
    HGW_PROJECT_RUNTIMES_ROOT: projectRuntimesRoot,
    HGW_PROJECTS_ROOT: projectsRoot,
    HGW_USER_PROJECTS_ROOT: userProjectsRoot,
    HGW_GATEWAY_DIR: gatewayDir,
    HGW_DSH_REPO_ROOT: dshRepoRoot,
    HGW_GUARD_PATCH: 'off',
    HGW_MODEL_GOVERNANCE_PACKAGE: join(root, 'model-governance'),
  })
  return { root, browse, cfg, usersRoot }
}

describe('administrator project directory browser', () => {
  it('lists one local host level, marks hidden folders, and omits files and reserved targets', () => {
    const { browse, cfg, usersRoot } = localFixture()
    mkdirSync(join(browse, 'Alpha'))
    mkdirSync(join(browse, 'Beta2'))
    mkdirSync(join(browse, 'Beta10'))
    mkdirSync(join(browse, '.hidden'))
    writeFileSync(join(browse, 'notes.txt'), 'not a directory')
    symlinkSync(usersRoot, join(browse, 'gateway-users'))
    symlinkSync('loop', join(browse, 'loop'))

    const listing = listProjectDirectories(cfg, browse)
    const canonicalBrowse = realpathSync(browse)

    expect(listing).toMatchObject({
      path: canonicalBrowse,
      scope: 'filesystem',
      selectable: true,
      truncated: false,
    })
    expect(listing.entries.filter(entry => !entry.hidden).map(entry => entry.name))
      .toEqual(['Alpha', 'Beta2', 'Beta10'])
    expect(listing.entries).toContainEqual({
      name: '.hidden', path: realpathSync(join(browse, '.hidden')), hidden: true,
    })
    expect(listing.entries.some(entry => entry.name === 'notes.txt')).toBe(false)
    expect(listing.entries.some(entry => entry.name === 'gateway-users')).toBe(false)
    expect(listing.entries.some(entry => entry.name === 'loop')).toBe(false)
    expect(listing.crumbs.at(-1)).toEqual({ name: 'browse', path: canonicalBrowse })
  })

  it('omits registered projects and bounds the response to 1,000 directories', () => {
    const { browse, cfg } = localFixture()
    const registered = join(browse, 'registered')
    mkdirSync(registered)
    for (let index = 0; index < 1_001; index += 1) {
      mkdirSync(join(browse, `folder-${String(index).padStart(4, '0')}`))
    }

    const listing = listProjectDirectories(cfg, browse, [registered])

    expect(listing.entries).toHaveLength(1_000)
    expect(listing.entries.some(entry => entry.path === registered)).toBe(false)
    expect(listing.truncated).toBe(true)
  })

  it('uses a virtual root for systemd and rejects symlinks that escape configured roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-systemd-directories-'))
    const firstRoot = join(root, 'first')
    const secondRoot = join(root, 'second')
    const outside = join(root, 'outside')
    const team = join(firstRoot, 'team')
    for (const path of [firstRoot, secondRoot, outside, team]) mkdirSync(path, { recursive: true })
    symlinkSync(outside, join(firstRoot, 'escape'))
    const cfg = loadConfig({
      HGW_LAUNCHER: 'systemd',
      HGW_PROJECT_PATH_ROOTS: `${firstRoot},${secondRoot}`,
      HGW_PROJECTS_ROOT: join(firstRoot, 'admin'),
      HGW_USER_PROJECTS_ROOT: join(firstRoot, 'user-projects'),
      HGW_USERS_ROOT: join(root, 'users'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
      HGW_GATEWAY_DIR: join(root, 'gateway'),
      HGW_DSH_REPO_ROOT: join(root, 'release'),
      HGW_GUARD_PATCH: 'off',
      HGW_MODEL_GOVERNANCE_PACKAGE: join(root, 'model-governance'),
    })

    expect(listProjectDirectories(cfg, undefined)).toMatchObject({
      path: null,
      scope: 'configured-roots',
      selectable: false,
      entries: [
        { name: 'first', path: realpathSync(firstRoot), hidden: false },
        { name: 'second', path: realpathSync(secondRoot), hidden: false },
      ],
    })
    const rootListing = listProjectDirectories(cfg, firstRoot)
    expect(rootListing.selectable).toBe(false)
    expect(rootListing.entries).toContainEqual({ name: 'team', path: realpathSync(team), hidden: false })
    expect(rootListing.entries.some(entry => entry.name === 'escape')).toBe(false)
    expect(listProjectDirectories(cfg, team).selectable).toBe(true)
    expect(() => listProjectDirectories(cfg, outside)).toThrow('project-directory-path-outside-root')
    expect(() => assertProjectImportPathAllowed(cfg, realpathSync(outside))).toThrow('project-path-outside-root')
  })

  it('bounds the systemd virtual root listing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-systemd-root-limit-'))
    const roots = Array.from({ length: 1_001 }, (_, index) => join(root, `root-${String(index).padStart(4, '0')}`))
    for (const path of roots) mkdirSync(path)
    const cfg = loadConfig({
      HGW_LAUNCHER: 'systemd',
      HGW_PROJECT_PATH_ROOTS: roots[0],
      HGW_PROJECTS_ROOT: join(roots[0]!, 'admin'),
      HGW_USER_PROJECTS_ROOT: join(roots[0]!, 'user-projects'),
      HGW_USERS_ROOT: join(root, 'users'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
      HGW_GATEWAY_DIR: join(root, 'gateway'),
      HGW_DSH_REPO_ROOT: join(root, 'release'),
      HGW_GUARD_PATCH: 'off',
      HGW_MODEL_GOVERNANCE_PACKAGE: join(root, 'model-governance'),
    })
    cfg.projectPathRoots = roots

    const listing = listProjectDirectories(cfg, undefined)

    expect(listing.entries).toHaveLength(1_000)
    expect(listing.entries.at(-1)?.name).toBe('root-0999')
    expect(listing.truncated).toBe(true)
  })

  it('returns stable diagnostics for invalid and reserved browser paths', () => {
    const { root, browse, cfg, usersRoot } = localFixture()
    const file = join(root, 'file')
    writeFileSync(file, 'not a directory')

    expect(() => listProjectDirectories(cfg, 'relative')).toThrow('project-directory-path-not-absolute')
    expect(() => listProjectDirectories(cfg, join(root, 'missing'))).toThrow('project-directory-path-not-found')
    expect(() => listProjectDirectories(cfg, file)).toThrow('project-directory-path-not-directory')
    expect(() => listProjectDirectories(cfg, usersRoot)).toThrow('project-directory-path-reserved')
    expect(() => assertProjectImportPathAllowed(cfg, realpathSync(browse))).not.toThrow()
    expect(() => assertProjectImportPathAllowed(cfg, realpathSync(usersRoot))).toThrow('project-path-reserved')
  })
})
