// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebar/setDetails clamp into the contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({
      sidebar: 400, details: 0, narrow: true, narrowExpanded: true,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('a rightbar presentation report collapses the squeeze-open sidebar: one narrow surface at a time', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({
      details: DETAILS_DEFAULT, narrowExpanded: false,
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
  })

  it('narrow sidebar requests leave auxiliary dismissal to the frame owner', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.openRightbar(true, false)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({
      details: DETAILS_DEFAULT, narrowExpanded: true,
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
    // The swap is symmetric: opening details again re-collapses the rail.
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({
      details: DETAILS_DEFAULT, narrowExpanded: false,
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
  })

  it('wide toggleSidebar is unaffected by an open details panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 0, details: DETAILS_DEFAULT })
  })

  it('collapseNarrow drops only the override (scrim tap / compact navigation)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.collapseNarrow()
    expect(store.getSnapshot()).toMatchObject({ narrowExpanded: false, sidebar: 400, narrow: true })
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
    expect(store.getSnapshot()).toMatchObject({
      narrow: false, narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('rightbar reports preserve resized width while releasing the visible track', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openRightbar(true, false)
    expect(store.getSnapshot().details).toBe(500)
    actions.closeRightbar()
    expect(store.getSnapshot()).toMatchObject({ details: 500, rightbarShown: false, rightbarTrack: false })
  })

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openRightbar(true, false)
    first.actions.setDetails(500)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
  })
})
