// The shared layout: how wide the window is, which panels sit beside the chat and
// which have become drawers laid over it, and the drawers' open/closed state.
//
// The decision itself is pure arithmetic (lib/layout-math.ts): the chat never
// gets narrower than MIN_CHAT. Under 768px both panels are drawers; above it the
// notes shrink first, and only when they cannot shrink further does the sidebar
// give way to a drawer. The panel *preferences* (a collapsed rail, the notes'
// dragged width) live here rather than in each panel because the sidebar has to
// know what the notes are doing, and vice versa — but they use the same
// localStorage keys as before, so saved settings carry over.
//
// Drawer open/closed state deliberately isn't persisted: a phone should always
// open on the chat, not on a panel left open last time.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import type { ReactNode } from "react"
import { useRouterState } from "@tanstack/react-router"

import { NOTES_DEFAULT, clampNotesWidth, computeLayout } from "@/lib/layout-math"
import type { LayoutResult } from "@/lib/layout-math"

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed"
const NOTES_COLLAPSED_KEY = "notes-panel-collapsed"
const NOTES_WIDTH_KEY = "notes-panel-width"

// localStorage can throw (private windows, blocked site data); a preference that
// can't be read or saved is just not remembered.
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true"
  } catch {
    return false
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // not remembered — fine
  }
}
function readNotesWidth(): number {
  try {
    const stored = Number(localStorage.getItem(NOTES_WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampNotesWidth(stored) : NOTES_DEFAULT
  } catch {
    return NOTES_DEFAULT
  }
}

function subscribeToWidth(onChange: () => void) {
  // Throttled to one update per frame: a window drag fires resize far faster
  // than the layout needs to re-run.
  let frame = 0
  const handler = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(onChange)
  }
  window.addEventListener("resize", handler)
  return () => {
    cancelAnimationFrame(frame)
    window.removeEventListener("resize", handler)
  }
}

/** The window's inner width, updated on resize and rotation. */
export function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.innerWidth,
    () => 1280,
  )
}

type LayoutValue = LayoutResult & {
  /** The window's inner width. */
  width: number
  /** True under the drawer breakpoint (phone-sized): both panels are drawers. */
  isSmall: boolean

  sidebarOpen: boolean
  notesOpen: boolean
  openSidebar: () => void
  closeSidebar: () => void
  openNotes: () => void
  closeNotes: () => void

  // The user's panel preferences, remembered across reloads.
  sidebarCollapsed: boolean
  toggleSidebarCollapsed: () => void
  notesCollapsed: boolean
  toggleNotesCollapsed: () => void
  /** The width the user dragged the notes to — a preference the layout may
   *  squeeze (see notesWidth) but never overwrites. */
  notesPreferredWidth: number
  setNotesPreferredWidth: (width: number, persist?: boolean) => void
  /** The notes panel registers itself, so the sidebar knows whether there is
   *  anything beside the chat to make room for. */
  setNotesPresent: (present: boolean) => void
}

const LayoutContext = createContext<LayoutValue | null>(null)

export function LayoutProvider({ children }: { children: ReactNode }) {
  const width = useWindowWidth()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readFlag(SIDEBAR_COLLAPSED_KEY))
  const [notesCollapsed, setNotesCollapsed] = useState(() => readFlag(NOTES_COLLAPSED_KEY))
  const [notesPreferredWidth, setPreferredWidth] = useState(readNotesWidth)
  const [notesPresent, setNotesPresent] = useState(false)

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writeFlag(SIDEBAR_COLLAPSED_KEY, !prev)
      return !prev
    })
  }, [])
  const toggleNotesCollapsed = useCallback(() => {
    setNotesCollapsed((prev) => {
      writeFlag(NOTES_COLLAPSED_KEY, !prev)
      return !prev
    })
  }, [])
  const setNotesPreferredWidth = useCallback((next: number, persist = false) => {
    const clamped = clampNotesWidth(next)
    setPreferredWidth(clamped)
    if (persist) {
      try {
        localStorage.setItem(NOTES_WIDTH_KEY, String(clamped))
      } catch {
        // not remembered — fine
      }
    }
  }, [])

  const layout = useMemo(
    () => computeLayout({ width, sidebarCollapsed, notesPresent, notesCollapsed, notesPreferredWidth }),
    [width, sidebarCollapsed, notesPresent, notesCollapsed, notesPreferredWidth],
  )

  // One drawer at a time: opening one closes the other.
  const openSidebar = useCallback(() => {
    setNotesOpen(false)
    setSidebarOpen(true)
  }, [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const openNotes = useCallback(() => {
    setSidebarOpen(false)
    setNotesOpen(true)
  }, [])
  const closeNotes = useCallback(() => setNotesOpen(false), [])

  // Navigating somewhere closes whatever was open. The other half of this — a
  // click on a link to the page you're already on — is handled by the sidebar
  // itself, since the pathname doesn't change then.
  useEffect(() => {
    setSidebarOpen(false)
    setNotesOpen(false)
  }, [pathname])

  // A panel that stops being a drawer (the window grew) must not leave a stale
  // "open" behind that would reappear if the window shrinks again.
  useEffect(() => {
    if (!layout.sidebarDrawer) setSidebarOpen(false)
  }, [layout.sidebarDrawer])
  useEffect(() => {
    if (!layout.notesDrawer) setNotesOpen(false)
  }, [layout.notesDrawer])

  const anyOpen = sidebarOpen || notesOpen
  useEffect(() => {
    if (!anyOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSidebarOpen(false)
        setNotesOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [anyOpen])

  const value = useMemo<LayoutValue>(
    () => ({
      ...layout,
      width,
      isSmall: layout.small,
      sidebarOpen,
      notesOpen,
      openSidebar,
      closeSidebar,
      openNotes,
      closeNotes,
      sidebarCollapsed,
      toggleSidebarCollapsed,
      notesCollapsed,
      toggleNotesCollapsed,
      notesPreferredWidth,
      setNotesPreferredWidth,
      setNotesPresent,
    }),
    [
      layout,
      width,
      sidebarOpen,
      notesOpen,
      openSidebar,
      closeSidebar,
      openNotes,
      closeNotes,
      sidebarCollapsed,
      toggleSidebarCollapsed,
      notesCollapsed,
      toggleNotesCollapsed,
      notesPreferredWidth,
      setNotesPreferredWidth,
    ],
  )
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
}

export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext)
  if (!value) throw new Error("useLayout must be used within a LayoutProvider")
  return value
}

/** Registers the calling component as "the notes panel is on screen" for as long
 *  as it is mounted. Layout effect, so the sidebar adjusts before the first paint
 *  instead of flashing in its old position for a frame. */
export function useRegisterNotesPanel() {
  const { setNotesPresent } = useLayout()
  useLayoutEffect(() => {
    setNotesPresent(true)
    return () => setNotesPresent(false)
  }, [setNotesPresent])
}
