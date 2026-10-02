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
  DETAILS_MAX_RATIO, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details preference unset, no viewport yet', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      panelInfo: { activePanelId: null },
      sidebar: SIDEBAR_DEFAULT, details: null, viewportWidth: 0, narrowExpanded: false,
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
    actions.setViewportWidth(1920)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(1920 * DETAILS_MAX_RATIO)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1920)
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1920)
    actions.setSidebar(400)
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({
      panelInfo: { activePanelId: null },
      sidebar: 400, details: null, viewportWidth: 980, narrowExpanded: true,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('a rightbar presentation report collapses the squeeze-open sidebar: one narrow surface at a time', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({
      details: null, narrowExpanded: false,
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
  })

  it('narrow sidebar requests leave auxiliary dismissal to the frame owner', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(980)
    actions.openRightbar(true, false)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({
      narrowExpanded: true,
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
    // The swap is symmetric: opening details again re-collapses the rail.
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({
      narrowExpanded: false,
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
  })

  it('wide toggleSidebar is unaffected by an open details panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1920)
    actions.openRightbar(true, false)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 0, details: null })
  })

  it('collapseNarrow drops only the override (scrim tap / compact navigation)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1920)
    actions.setSidebar(400)
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.collapseNarrow()
    expect(store.getSnapshot()).toMatchObject({ narrowExpanded: false, sidebar: 400, viewportWidth: 980 })
    // Idempotent while already collapsed.
    actions.collapseNarrow()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('crossing the breakpoint drops the override; a same-side resize keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setViewportWidth(960)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setViewportWidth(1920)
    expect(store.getSnapshot()).toMatchObject({
      viewportWidth: 1920, narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
    actions.setViewportWidth(980)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('opening leaves the preference unset; a dragged width survives close/open', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1920)
    actions.openRightbar(true, false)
    // The ratio default resolves in the frame at render time, not here.
    expect(store.getSnapshot().details).toBeNull()
    actions.setDetails(500)
    actions.closeRightbar()
    expect(store.getSnapshot()).toMatchObject({ details: 500, rightbarShown: false, rightbarTrack: false })
    // Reopening keeps the dragged preference; the frame stops deriving.
    actions.openRightbar(true, false)
    expect(store.getSnapshot().details).toBe(500)
  })

  it('an untouched preference still tracks viewport changes (resolved per render)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1440)
    actions.openRightbar(true, false)
    actions.setViewportWidth(1920)
    expect(store.getSnapshot().details).toBeNull()
  })

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setViewportWidth(1920)
    first.actions.setSidebar(400)
    first.actions.openRightbar(true, false)
    first.actions.setDetails(500)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      panelInfo: { activePanelId: null },
      sidebar: SIDEBAR_DEFAULT,
      details: null,
      viewportWidth: 0,
      narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    })
  })
})
