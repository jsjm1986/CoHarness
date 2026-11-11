// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { spaceRowEntries, stewardChildName, stewardSpaceBase, type SpaceDestination } from '../src/client/space-destinations.ts'

const destination = (name: string, nodeName: string, steward = false): SpaceDestination => ({
  id: `space:${name}`,
  target: { kind: 'project', projectId: name.length },
  name,
  nodeName,
  ...(steward ? { project: { projectId: name.length, name, path: '/srv/x', mode: 'rw', kind: 'steward' } as const } : {}),
  current: false,
})

describe('spaceRowEntries', () => {
  it('keeps plain rows when fewer than two maintenance destinations share a group', () => {
    const items = [destination('维护中枢·mac-mini', 'mac-mini', true), destination('微信客服', 'mac-mini')]
    expect(spaceRowEntries(items)).toEqual([
      { kind: 'destination', destination: items[0] },
      { kind: 'destination', destination: items[1] },
    ])
  })

  it('folds multi-computer maintenance destinations once at the first steward position', () => {
    const items = [
      destination('微信客服', 'mac-mini'),
      destination('维护中枢·windows-vps-47', 'windows-vps-47', true),
      destination('小红书采集', 'mac-mini'),
      destination('维护中枢·ubuntu-101-36-115-219', 'ubuntu-101-36-115-219', true),
      destination('维护中枢·mac-mini', 'mac-mini', true),
    ]
    const entries = spaceRowEntries(items)
    expect(entries.map(entry => entry.kind)).toEqual(['destination', 'steward', 'destination'])
    const fold = entries[1]!
    expect(fold.kind === 'steward' && fold.destinations).toEqual([items[1], items[3], items[4]])
  })

  it('flattens every row while the search query filters identities', () => {
    const items = [
      destination('维护中枢·windows-vps-47', 'windows-vps-47', true),
      destination('维护中枢·mac-mini', 'mac-mini', true),
    ]
    expect(spaceRowEntries(items, true).map(entry => entry.kind)).toEqual(['destination', 'destination'])
  })
})

describe('stewardSpaceBase', () => {
  it('strips the agreed per-computer suffix to the shared space name', () => {
    const items = [
      destination('维护中枢·windows-vps-47', 'windows-vps-47', true),
      destination('维护中枢·ubuntu-101-36-115-219', 'ubuntu-101-36-115-219', true),
      destination('维护中枢·mac-mini', 'mac-mini', true),
    ]
    expect(stewardSpaceBase(items)).toBe('维护中枢')
  })

  it('falls back to the first name prefix when members disagree on the base', () => {
    const items = [
      destination('维护中枢·windows-vps-47', 'windows-vps-47', true),
      destination('维护中枢', 'mac-mini', true),
    ]
    expect(stewardSpaceBase(items)).toBe('维护中枢')
  })
})

describe('stewardChildName', () => {
  it('drops the node tail the child row already shows as its computer line', () => {
    expect(stewardChildName(destination('维护中枢·windows-vps-47', 'windows-vps-47', true))).toBe('维护中枢')
    expect(stewardChildName(destination('维护中枢', 'mac-mini', true))).toBe('维护中枢')
  })
})
