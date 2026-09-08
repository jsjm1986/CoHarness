import { describe, expect, it } from 'vitest'
import { parseWorkbenchCatalog } from '../src/client/catalog.ts'

describe('workbench account catalog', () => {
  it('preserves personal and project runtime targets', () => {
    const catalog = parseWorkbenchCatalog({
      personal: { id: 1, name: 'Me' },
      activeRuntime: { kind: 'project', projectId: 7 },
      projects: [{ projectId: 7, name: 'Demo', mode: 'ro' }],
      items: [{
        sessionId: 's-project',
        runtime: { kind: 'project', projectId: 7, projectName: 'Demo' },
        visibility: 'project', creatorUserId: 2, creatorDisplayName: 'Alice',
        updatedAt: 1, blank: false, canWrite: false,
      }],
    })
    expect(catalog.activeRuntime).toEqual({ kind: 'project', projectId: 7 })
    expect(catalog.items[0]?.runtime).toEqual({ kind: 'project', projectId: 7, projectName: 'Demo' })
  })

  it('rejects malformed or incomplete rows', () => {
    expect(() => parseWorkbenchCatalog({
      personal: { id: 1, name: 'Me' },
      activeRuntime: { kind: 'personal' }, projects: [], items: [{ sessionId: 'x' }],
    })).toThrow('invalid workbench catalog')
  })
})

const valid = () => ({ personal: { id: 1, name: 'Me' }, activeRuntime: { kind: 'personal' }, projects: [], items: [] })

describe('catalog wire validation', () => {
  it.each([null, [], 'bad', 1])('rejects non-object catalogs (%j)', (value) => {
    expect(() => parseWorkbenchCatalog(value)).toThrow('invalid workbench catalog')
  })
  it.each([
    { personal: { id: 0, name: 'Me' } }, { personal: { id: 1.1, name: 'Me' } },
    { personal: { id: '1', name: 'Me' } }, { personal: { id: 1, name: null } },
    { activeRuntime: { kind: 'unknown' } }, { activeRuntime: { kind: 'project', projectId: '1' } },
    { activeRuntime: { kind: 'project', projectId: 0 } }, { activeRuntime: { kind: 'project', projectId: 0.5 } },
    { projects: {} }, { items: {} },
  ])('rejects invalid catalog ownership or collections (%j)', (fields) => {
    expect(() => parseWorkbenchCatalog({ ...valid(), ...fields })).toThrow('invalid workbench catalog')
  })
  it.each([{ projectId: 0 }, { projectId: 0.5 }, { projectId: '1' }, { name: 2 }, { mode: 'admin' }])('rejects invalid project metadata (%j)', (fields) => {
    expect(() => parseWorkbenchCatalog({ ...valid(), projects: [{ projectId: 1, name: 'A', mode: 'rw', ...fields }] })).toThrow('invalid workbench project')
  })
  it.each([
    { sessionId: '' }, { title: 4 }, { cwd: 4 }, { visibility: 'public' }, { creatorUserId: '1' },
    { creatorUserId: 1.5 }, { creatorDisplayName: 2 }, { updatedAt: null }, { blank: 'false' }, { canWrite: null },
    { runtime: { kind: 'unknown' } }, { runtime: { kind: 'project', projectId: 0, projectName: 'A' } },
    { runtime: { kind: 'project', projectId: 0.5, projectName: 'A' } },
    { runtime: { kind: 'project', projectId: '1', projectName: 'A' } }, { runtime: { kind: 'project', projectId: 1 } },
  ])('rejects malformed conversation rows (%j)', (fields) => {
    expect(() => parseWorkbenchCatalog({ ...valid(), items: [{ sessionId: 's', runtime: { kind: 'personal' }, visibility: 'private', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true, ...fields }] })).toThrow('invalid workbench conversation')
  })
  it('accepts a complete personal row and rw project', () => {
    expect(parseWorkbenchCatalog({ ...valid(), projects: [{ projectId: 1, name: 'A', mode: 'rw' }], items: [{ sessionId: 's', runtime: { kind: 'personal' }, title: 'Title', cwd: '/work', visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true }] }).items).toHaveLength(1)
  })
})
