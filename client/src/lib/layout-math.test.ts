import { describe, expect, it } from "vitest"

import {
  DRAWER_BREAKPOINT,
  MIN_CHAT,
  NOTES_DEFAULT,
  NOTES_MIN,
  NOTES_RAIL,
  SIDEBAR_FULL,
  SIDEBAR_RAIL,
  clampNotesWidth,
  computeLayout,
  type LayoutInput,
} from "./layout-math"

const base: LayoutInput = {
  width: 1200,
  sidebarCollapsed: false,
  notesPresent: true,
  notesCollapsed: false,
  notesPreferredWidth: NOTES_DEFAULT,
}
const at = (width: number, over: Partial<LayoutInput> = {}) => computeLayout({ ...base, ...over, width })

const WIDTHS = [320, 480, 600, 767, 768, 800, 850, 900, 935, 936, 937, 1000, 1035, 1036, 1100, 1200, 1440, 1600, 2560]
const PREFERRED = [NOTES_MIN, 380, NOTES_DEFAULT, 600, 720, 5000, -20, NaN]

describe("under the breakpoint", () => {
  it("makes both panels drawers and gives the chat the whole window", () => {
    for (const width of [320, 390, 490, 767]) {
      const l = at(width)
      expect(l).toMatchObject({ small: true, sidebarDrawer: true, notesDrawer: true, chatWidth: width })
    }
  })

  it("starts exactly at the breakpoint", () => {
    expect(at(DRAWER_BREAKPOINT - 1).small).toBe(true)
    expect(at(DRAWER_BREAKPOINT).small).toBe(false)
  })
})

describe("at the breakpoint and above", () => {
  it("never lets the chat get narrower than the minimum, whatever the panels prefer", () => {
    for (const width of WIDTHS.filter((w) => w >= DRAWER_BREAKPOINT))
      for (const sidebarCollapsed of [false, true])
        for (const notesPresent of [false, true])
          for (const notesCollapsed of [false, true])
            for (const notesPreferredWidth of PREFERRED) {
              const l = at(width, { sidebarCollapsed, notesPresent, notesCollapsed, notesPreferredWidth })
              expect(l.chatWidth, JSON.stringify({ width, sidebarCollapsed, notesPresent, notesCollapsed })).toBeGreaterThanOrEqual(
                MIN_CHAT,
              )
            }
  })

  it("never turns the notes into a drawer", () => {
    for (const width of WIDTHS.filter((w) => w >= DRAWER_BREAKPOINT))
      for (const preferred of PREFERRED) expect(at(width, { notesPreferredWidth: preferred }).notesDrawer).toBe(false)
  })

  it("never lets the notes fall below their own minimum", () => {
    for (const width of WIDTHS.filter((w) => w >= DRAWER_BREAKPOINT))
      for (const preferred of PREFERRED)
        expect(at(width, { notesPreferredWidth: preferred }).notesWidth).toBeGreaterThanOrEqual(NOTES_MIN)
  })

  it("puts no upper limit on the notes other than the chat's minimum", () => {
    // A very wide preference on a very wide window is honoured in full...
    expect(at(2560, { notesPreferredWidth: 1500 }).notesWidth).toBe(1500)
    // ...and only ever cut to leave the chat its 360px.
    expect(at(1200, { notesPreferredWidth: 5000 }).chatWidth).toBe(MIN_CHAT)
  })

  it("adds up: sidebar + notes + chat is the window", () => {
    for (const width of WIDTHS.filter((w) => w >= DRAWER_BREAKPOINT)) {
      const l = at(width)
      const sidebar = l.sidebarDrawer ? 0 : SIDEBAR_FULL
      expect(sidebar + l.notesWidth + l.chatWidth).toBe(width)
    }
  })
})

describe("the squeeze zone, with notes open", () => {
  it("keeps the sidebar and the full notes width when there is room", () => {
    // 1036 = 256 + 420 + 360: exactly enough for everything.
    expect(at(1036)).toMatchObject({ sidebarDrawer: false, notesWidth: 420, chatWidth: 360 })
    expect(at(1600)).toMatchObject({ sidebarDrawer: false, notesWidth: 420, chatWidth: 1600 - 256 - 420 })
  })

  it("shrinks the notes before it touches the sidebar", () => {
    const l = at(1000)
    expect(l.sidebarDrawer).toBe(false)
    expect(l.notesWidth).toBe(1000 - SIDEBAR_FULL - MIN_CHAT) // 384
    expect(l.chatWidth).toBe(MIN_CHAT)
    // ...continuing down to the notes' own minimum.
    expect(at(936)).toMatchObject({ sidebarDrawer: false, notesWidth: NOTES_MIN, chatWidth: MIN_CHAT })
  })

  it("turns the sidebar into a drawer only once the notes cannot shrink further", () => {
    const l = at(935)
    expect(l.sidebarDrawer).toBe(true)
    expect(l.notesDrawer).toBe(false)
    expect(l.notesWidth).toBe(NOTES_DEFAULT) // the notes get their full width back
    expect(l.chatWidth).toBe(935 - NOTES_DEFAULT)
  })

  it("at the breakpoint, gives the chat exactly its minimum", () => {
    expect(at(768)).toMatchObject({ sidebarDrawer: true, notesDrawer: false, notesWidth: 408, chatWidth: 360 })
  })

  it("was 92px before this rule: 768 - 256 - 420", () => {
    expect(768 - SIDEBAR_FULL - NOTES_DEFAULT).toBe(92)
    expect(at(768).chatWidth).toBeGreaterThanOrEqual(MIN_CHAT)
  })
})

describe("no flapping", () => {
  it("never flips the sidebar back to a drawer as the window grows", () => {
    for (const sidebarCollapsed of [false, true])
      for (const preferred of PREFERRED) {
        let docked = false
        for (let width = DRAWER_BREAKPOINT; width <= 2000; width++) {
          const { sidebarDrawer } = at(width, { sidebarCollapsed, notesPreferredWidth: preferred })
          if (!sidebarDrawer) docked = true
          // Once docked, it stays docked for every wider window.
          expect(!(docked && sidebarDrawer), `width ${width}`).toBe(true)
        }
      }
  })

  it("does the same whichever way the window is resized (a pure function of its inputs)", () => {
    const down = [1200, 1100, 1000, 900, 800, 768].map((w) => at(w))
    const up = [768, 800, 900, 1000, 1100, 1200].map((w) => at(w)).reverse()
    expect(down).toEqual(up)
  })
})

describe("panels the user has collapsed", () => {
  it("honours a collapsed sidebar rail, which leaves room for more", () => {
    // 56px rail: 800 - 56 - 360 = 384 >= 320, so it stays docked where a full sidebar could not.
    expect(at(800, { sidebarCollapsed: true })).toMatchObject({ sidebarDrawer: false, notesWidth: 384 })
    expect(at(800)).toMatchObject({ sidebarDrawer: true })
  })

  it("docks everything when the notes are a rail", () => {
    const l = at(768, { notesCollapsed: true })
    expect(l).toMatchObject({ sidebarDrawer: false, notesDrawer: false, notesWidth: NOTES_RAIL })
    expect(l.chatWidth).toBe(768 - SIDEBAR_FULL - NOTES_RAIL)
  })

  it("has no notes panel at all when there are no notes", () => {
    const l = at(800, { notesPresent: false })
    expect(l).toMatchObject({ sidebarDrawer: false, notesWidth: 0, chatWidth: 800 - SIDEBAR_FULL })
  })

  it("uses the rail width for a collapsed sidebar with no notes", () => {
    expect(at(800, { notesPresent: false, sidebarCollapsed: true }).chatWidth).toBe(800 - SIDEBAR_RAIL)
  })
})

describe("the drag limit", () => {
  it("is the widest the notes can be without squeezing the chat below the minimum", () => {
    // Sidebar docked: 1200 - 256 - 360.
    expect(at(1200).notesMaxWidth).toBe(584)
    expect(at(1000).notesMaxWidth).toBe(1000 - SIDEBAR_FULL - MIN_CHAT) // 384
    // Sidebar a drawer: only the chat's minimum has to be kept.
    expect(at(935).notesMaxWidth).toBe(935 - MIN_CHAT) // 575
    expect(at(768).notesMaxWidth).toBe(768 - MIN_CHAT) // 408
  })

  it("has no fixed ceiling: on a huge window the notes can take everything but the sidebar and the chat's minimum", () => {
    expect(at(2560).notesMaxWidth).toBe(2560 - SIDEBAR_FULL - MIN_CHAT) // 1944
    expect(at(1920).notesMaxWidth).toBe(1920 - SIDEBAR_FULL - MIN_CHAT) // 1304
  })

  it("always leaves the chat its minimum when the notes are dragged all the way out", () => {
    for (const width of WIDTHS.filter((w) => w >= DRAWER_BREAKPOINT)) {
      const { notesMaxWidth } = at(width)
      expect(at(width, { notesPreferredWidth: notesMaxWidth }).chatWidth).toBeGreaterThanOrEqual(MIN_CHAT)
    }
  })

  it("never drops below the notes' own minimum", () => {
    expect(at(320).notesMaxWidth).toBeGreaterThanOrEqual(NOTES_MIN)
  })

  it("squeezes an over-wide preference to fit beside the docked sidebar, rather than moving the sidebar", () => {
    const l = at(1200, { notesPreferredWidth: 900 })
    expect(l.sidebarDrawer).toBe(false)
    expect(l.notesWidth).toBe(584)
    expect(l.chatWidth).toBe(MIN_CHAT)
  })
})

describe("clampNotesWidth", () => {
  it("clamps into range, and falls back to the default for nonsense", () => {
    expect(clampNotesWidth(100)).toBe(NOTES_MIN)
    expect(clampNotesWidth(5000)).toBe(5000) // no upper limit
    expect(clampNotesWidth(500)).toBe(500)
    expect(clampNotesWidth(NaN)).toBe(NOTES_DEFAULT)
  })
})
