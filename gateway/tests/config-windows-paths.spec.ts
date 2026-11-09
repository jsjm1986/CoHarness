/** Windows directory grammar is validated through the ordinary configuration parser. */
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('node:path', async importOriginal => {
  const path = await importOriginal<typeof import('node:path')>()
  return { ...path, ...path.win32, posix: path.win32 }
})

import { loadConfig } from '../src/config.ts'

afterAll(() => { vi.doUnmock('node:path') })

const environment = {
  HGW_USERS_ROOT: 'C:\\runtime-users',
  HGW_PROJECT_RUNTIMES_ROOT: 'C:\\project-runtimes',
  HGW_USER_PROJECTS_ROOT: 'C:\\user-projects',
  HGW_PROJECTS_ROOT: 'C:\\managed-projects',
  HGW_STATE_ROOT: 'C:\\gateway-state',
  HGW_GATEWAY_DIR: 'C:\\gateway',
  HGW_DSH_REPO_ROOT: 'C:\\source',
  HGW_DSH_COMMAND: 'node dsh --no-open',
}

it.each(['C:\\', '\\\\server\\share\\'])('refuses the Windows filesystem root %s as a project data root', root => {
  expect(() => loadConfig({ ...environment, HGW_PROJECT_PATH_ROOTS: root })).toThrow('filesystem root')
})

it('retains a Windows drive subdirectory as the authorized project root', () => {
  expect(loadConfig({ ...environment, HGW_PROJECT_PATH_ROOTS: 'C:\\project-data' }).projectPathRoots).toEqual(['C:\\project-data'])
})

it.each([
  ['C:\\project-data', 'D:\\project-data'],
  ['\\\\first\\share\\project-data', '\\\\second\\share\\project-data'],
])('retains distinct Windows volume directories %s and %s', (first, second) => {
  expect(loadConfig({ ...environment, HGW_PROJECT_PATH_ROOTS: `${first},${second}` }).projectPathRoots).toEqual([first, second])
})

it.each([
  ['C:\\project-data', 'C:\\project-data\\nested'],
  ['C:\\project-data\\nested', 'C:\\project-data'],
  ['C:\\project-data', 'c:\\project-data\\child\\..'],
])('refuses overlapping Windows directories %s and %s', (first, second) => {
  expect(() => loadConfig({ ...environment, HGW_PROJECT_PATH_ROOTS: `${first},${second}` })).toThrow('overlapping roots')
})
