/** Contract checks on the authored Dependabot upgrade policy. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface DependabotIgnoreRule {
  'dependency-name'?: string
  'update-types'?: readonly string[]
  versions?: readonly string[]
}

interface DependabotUpdate {
  'package-ecosystem': string
  directory: string
  'open-pull-requests-limit'?: number
  schedule: { interval: string; day?: string; time?: string; timezone?: string }
  groups?: Record<string, { patterns?: readonly string[] }>
  ignore?: DependabotIgnoreRule[]
}

const root = resolve(import.meta.dirname, '..')
const updates = (parseYaml(readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8')) as {
  updates: DependabotUpdate[]
}).updates

function ecosystem(name: string): DependabotUpdate {
  const update = updates.find(entry => entry['package-ecosystem'] === name)
  if (update === undefined) throw new Error(`dependabot.yml: missing ${name} ecosystem`)
  return update
}

describe('dependency upgrade cadence and grouping', () => {
  it('gates every ecosystem to one scheduled weekly window', () => {
    for (const name of ['npm', 'uv', 'github-actions']) {
      expect(ecosystem(name).schedule, name).toEqual({
        interval: 'weekly', day: 'monday', time: '04:00', timezone: 'Asia/Shanghai',
      })
    }
    expect(ecosystem('npm')['open-pull-requests-limit']).toBe(2)
    expect(ecosystem('uv')['open-pull-requests-limit']).toBe(1)
    expect(ecosystem('github-actions')['open-pull-requests-limit']).toBe(1)
  })

  it('groups the Vitest family and bundled pnpm explicitly for npm', () => {
    const npm = ecosystem('npm')
    expect(npm.groups).toMatchObject({
      vitest: { patterns: ['vitest', '@vitest/*'] },
      'bundled-pnpm': { patterns: ['pnpm'] },
    })
  })

  it('holds only the named families at major versions, never a wildcard', () => {
    const npm = ecosystem('npm')
    const ignored = new Map((npm.ignore ?? []).map(rule => [rule['dependency-name'], rule]))
    for (const name of ['pnpm', '@vitejs/plugin-react', 'vitest', '@vitest/*']) {
      expect(ignored.get(name), name).toMatchObject({ 'update-types': ['version-update:semver-major'] })
    }
    expect(npm.ignore?.some(rule => rule['dependency-name'] === '*')).toBe(false)
    expect(npm.ignore?.every(rule =>
      rule['update-types'] !== undefined || rule.versions !== undefined)).toBe(true)
  })

  it('holds exactly pnpm/action-setup 6.1.0 pending installer verification', () => {
    const actions = ecosystem('github-actions')
    expect(actions.ignore).toEqual([{ 'dependency-name': 'pnpm/action-setup', versions: ['6.1.0'] }])
    expect(actions.ignore?.[0]?.['update-types']).toBeUndefined()
  })
})
