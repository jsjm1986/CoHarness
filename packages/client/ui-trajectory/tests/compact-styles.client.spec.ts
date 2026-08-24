/**
 * Compact trajectory stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Read a stylesheet next to this spec.
 * @param rel - path relative to this file.
 * @returns file text.
 */
function load(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

describe('trajectory compact chrome', () => {
  it('lets ledger cells wrap and meet the touch target on compact', () => {
    const cell = load('../src/client/TrajectoryCell.module.css')
    const header = load('../src/client/TrajectoryGroupHeader.module.css')
    const turn = load('../src/client/TrajectoryTurnHeader.module.css')
    expect(cell).toContain("[data-viewport='compact']")
    expect(cell).toContain('white-space: normal')
    expect(cell).toContain('min-height: var(--dsw-touch-target)')
    expect(header).toContain("[data-viewport='compact']")
    expect(header).toContain('white-space: normal')
    expect(turn).toContain("[data-viewport='compact']")
    expect(turn).toContain('flex-wrap: wrap')
  })

  it('grows the timeline earlier-history and table close controls on compact', () => {
    const timeline = load('../src/client/TrajectoryTimeline.module.css')
    const table = load('../src/client/TrajectoryTable.module.css')
    const views = load('../src/client/views.module.css')
    expect(timeline).toContain("[data-viewport='compact']")
    expect(timeline).toContain('.earlierHistory')
    expect(timeline).toContain('var(--dsw-touch-target)')
    expect(table).toContain("[data-viewport='compact']")
    expect(table).toContain('.close')
    expect(table).toContain('var(--dsw-touch-target)')
    expect(table).toContain('@media (max-width: 767px)')
    expect(table).toContain('width: 100%')
    expect(table).toContain('white-space: normal')
    expect(views).toContain('[data-trajectory-details]')
    expect(views).toContain('z-index: 8')
  })

  it('ships a flat compact event feed and one-row toolbar controls', () => {
    const feed = load('../src/client/TrajectoryMobileFeed.module.css')
    const toolbar = load('../src/client/TrajectoryToolbar.module.css')
    expect(feed).toContain('.feed')
    expect(feed).toContain('var(--dsw-mobile-feed-row-height)')
    expect(feed).toContain('font: var(--dsw-mobile-font-feed-meta)')
    expect(toolbar).toContain('var(--dsw-mobile-toolbar-height)')
    expect(toolbar).toContain('.mobileControls')
    expect(toolbar).toContain('.mobileSearch')
  })
})
