// How wide is the chat going to be, and which panels have to give way for it to
// stay usable? Pure arithmetic — no DOM — so it can be tested to death.
//
// The rule: the chat never drops below MIN_CHAT (360px) at 768px and up. It is
// *computed* from the window width and the panel widths rather than measured
// off the page: measuring would feed back on itself (docking a panel narrows the
// chat, which would flip the panel back to an overlay, and so on).
//
//   under 768px   both panels are drawers over the chat (phones).
//   768px and up  1. the notes shrink first, down to NOTES_MIN, beside a docked
//                    sidebar;
//                 2. if they would have to go below that, the sidebar becomes a
//                    drawer instead, and the notes stay docked beside the chat.
//                 The notes themselves never become a drawer at 768px and up:
//                 once the sidebar has given way, 768 - 360 leaves them >= 320.

/** Under this width both panels are drawers. Tailwind's `md`. */
export const DRAWER_BREAKPOINT = 768
/** The smallest the chat is allowed to get while the layout is side by side. */
export const MIN_CHAT = 360
export const SIDEBAR_FULL = 256
export const SIDEBAR_RAIL = 56
export const NOTES_MIN = 320
export const NOTES_DEFAULT = 420
export const NOTES_RAIL = 48

export type LayoutInput = {
  /** The window's inner width. */
  width: number
  /** The user's choice to shrink the docked sidebar to a slim rail. */
  sidebarCollapsed: boolean
  /** Whether the conversation has notes (no notes, no panel). */
  notesPresent: boolean
  /** The user's choice to shrink the docked notes to a slim rail. */
  notesCollapsed: boolean
  /** The width the user dragged the notes to (or the default) — their
   *  preference, which the layout may squeeze but never overwrites. There is no
   *  upper limit on it: the notes may grow until the chat would drop below
   *  MIN_CHAT, and no further. */
  notesPreferredWidth: number
}

export type LayoutResult = {
  /** Under the breakpoint: phone-sized. */
  small: boolean
  sidebarDrawer: boolean
  notesDrawer: boolean
  /** The width the docked notes panel actually gets (0 when absent or a drawer). */
  notesWidth: number
  /** The most the notes can be dragged to in this layout: past it the chat would
   *  drop below MIN_CHAT. Dragging never moves the sidebar out of the way — it
   *  just stops here. */
  notesMaxWidth: number
  /** The width the chat ends up with. */
  chatWidth: number
}

/** The notes have a minimum but no maximum: the chat's minimum is the only
 *  thing that limits how wide they can get (see computeLayout). */
export function clampNotesWidth(width: number): number {
  if (!Number.isFinite(width)) return NOTES_DEFAULT
  return Math.max(NOTES_MIN, width)
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const { width, sidebarCollapsed, notesPresent, notesCollapsed } = input
  const preferred = clampNotesWidth(input.notesPreferredWidth)
  // What the notes could be if only the chat's minimum had to be respected.
  const maxWith = (sidebarWidth: number) => Math.max(NOTES_MIN, width - sidebarWidth - MIN_CHAT)

  if (width < DRAWER_BREAKPOINT) {
    return {
      small: true,
      sidebarDrawer: true,
      notesDrawer: true,
      notesWidth: 0,
      notesMaxWidth: maxWith(0),
      chatWidth: width,
    }
  }

  const sidebarDocked = sidebarCollapsed ? SIDEBAR_RAIL : SIDEBAR_FULL

  // No notes: just the sidebar and the chat. 768 - 256 = 512, always enough.
  if (!notesPresent) {
    return {
      small: false,
      sidebarDrawer: false,
      notesDrawer: false,
      notesWidth: 0,
      notesMaxWidth: maxWith(sidebarDocked),
      chatWidth: width - sidebarDocked,
    }
  }

  // A collapsed notes rail is only 48px, so everything fits docked.
  if (notesCollapsed) {
    return {
      small: false,
      sidebarDrawer: false,
      notesDrawer: false,
      notesWidth: NOTES_RAIL,
      notesMaxWidth: maxWith(sidebarDocked),
      chatWidth: width - sidebarDocked - NOTES_RAIL,
    }
  }

  // 1. Sidebar docked: the notes take what the chat can spare, down to NOTES_MIN.
  const roomBesideSidebar = width - sidebarDocked - MIN_CHAT
  if (roomBesideSidebar >= NOTES_MIN) {
    const notesWidth = Math.min(preferred, roomBesideSidebar)
    return {
      small: false,
      sidebarDrawer: false,
      notesDrawer: false,
      notesWidth,
      notesMaxWidth: maxWith(sidebarDocked),
      chatWidth: width - sidebarDocked - notesWidth,
    }
  }

  // 2. Not enough room for both: the sidebar becomes a drawer, and the notes
  //    stay beside the chat, taking what it can spare (>= NOTES_MIN here).
  const notesWidth = Math.min(preferred, width - MIN_CHAT)
  return {
    small: false,
    sidebarDrawer: true,
    notesDrawer: false,
    notesWidth,
    notesMaxWidth: maxWith(0),
    chatWidth: width - notesWidth,
  }
}
