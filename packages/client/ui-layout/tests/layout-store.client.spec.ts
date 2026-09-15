// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the stepped action write set
 * (open = contract default width, closed = 0), and the absence of browser
 * persistence. Uses the test-sanctioned path: factory self-call + .create()
 * gives the real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import { DETAILS_DEFAULT, SIDEBAR_DEFAULT } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({ sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.toggleSidebar()
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('toggleSidebar flips closed <-> contract default', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({ sidebar: SIDEBAR_DEFAULT, details: 0, narrow: true, narrowExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow openDetails collapses the squeeze-open sidebar: one narrow surface at a time', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.openDetails()
    expect(store.getSnapshot()).toMatchObject({ details: DETAILS_DEFAULT, narrowExpanded: false })
  })

  it('narrow toggleSidebar while details is open swaps surfaces instead of sharing the frame', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.openDetails()
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ details: 0, narrowExpanded: true })
    // The swap is symmetric: opening details again re-collapses the rail.
    actions.openDetails()
    expect(store.getSnapshot()).toMatchObject({ details: DETAILS_DEFAULT, narrowExpanded: false })
  })

  it('wide toggleSidebar is unaffected by an open details panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 0, details: DETAILS_DEFAULT })
  })

  it('collapseNarrow drops only the override (scrim tap / compact navigation)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.collapseNarrow()
    expect(store.getSnapshot()).toMatchObject({ narrowExpanded: false, sidebar: SIDEBAR_DEFAULT, narrow: true })
    // Idempotent while already collapsed.
    actions.collapseNarrow()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('openDetails uses the contract default, keeps an already-open panel, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.toggleSidebar()
    first.actions.openDetails()
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
    })
  })
})
