// Right-side panel showing the conversation's persistent lecture-notes
// document — similar to how Claude opens a document/artifact panel next to
// the chat. Only rendered once notes actually exist for the conversation.
//
// Beside the chat, its width is user-resizable (drag the left edge) and
// collapsible, both remembered across reloads — but the *actual* width is
// decided by the layout (lib/layout-math.ts): it narrows before the chat would
// drop below its minimum, and the drag stops where the chat would. Under 768px
// it is a drawer laid over the chat instead.
import { useEffect, useRef, useState } from "react"
import { PanelRightClose, PanelRightOpen, X } from "lucide-react"

import { Markdown } from "@/components/markdown"
import { useLayout, useRegisterNotesPanel } from "@/lib/layout-context"
import { NOTES_MIN, NOTES_RAIL } from "@/lib/layout-math"

/** First-open slide and the collapse/expand slide; keep under 1s. */
const ENTER_MS = 450

export function NotesPanel({
  content,
  animateEnter = false,
  notice,
  onDismissNotice,
}: {
  content: string
  /** A neutral heads-up (not an error), e.g. that some slides aren't placed yet. */
  notice?: string | null
  onDismissNotice?: () => void
  /** Slide open from width 0 when notes first appear (new chat / first create). */
  animateEnter?: boolean
}) {
  // Under 768px this is a drawer laid over the chat instead of a panel beside
  // it (see lib/layout-context.tsx); the drag/collapse/enter-animation state
  // below only applies to the docked layout.
  const layout = useLayout()
  // Tell the layout the notes are on screen, so the sidebar can make room.
  useRegisterNotesPanel()
  const collapsed = layout.notesCollapsed

  // Capture enter intent only on mount so a later prop flip doesn't cancel
  // the open animation mid-flight.
  const shouldAnimateRef = useRef(animateEnter)
  const [entered, setEntered] = useState(!shouldAnimateRef.current)
  const [isDragging, setIsDragging] = useState(false)
  const draggingRef = useRef(false)
  const draggedWidthRef = useRef(layout.notesPreferredWidth)
  // The pointer handlers are registered once, so they read the latest layout
  // through a ref rather than closing over a stale one.
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  })

  // The width and opacity slide only for the first opening and for collapse /
  // expand. Otherwise the width simply follows the window — animating it would
  // make the panel lag behind while the window is being resized.
  const [animating, setAnimating] = useState(shouldAnimateRef.current)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function animateForAWhile() {
    setAnimating(true)
    if (animationTimerRef.current) clearTimeout(animationTimerRef.current)
    animationTimerRef.current = setTimeout(() => setAnimating(false), ENTER_MS + 60)
  }
  useEffect(
    () => () => {
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!shouldAnimateRef.current) return
    // Paint width:0 first, then open — otherwise the transition never runs.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setEntered(true)
        animateForAWhile()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])

  // Registered once (not per-drag) so we're not adding/removing listeners
  // on every pointermove during a drag — refs carry the live values instead.
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      if (!draggingRef.current) return
      const current = layoutRef.current
      // Panel sits on the right edge; the handle is its left edge, so
      // dragging the pointer left (smaller clientX) should widen it — up to the
      // point where the chat would drop below its minimum.
      const next = Math.min(current.notesMaxWidth, Math.max(NOTES_MIN, window.innerWidth - e.clientX))
      draggedWidthRef.current = next
      current.setNotesPreferredWidth(next)
    }
    function onPointerUp() {
      if (!draggingRef.current) return
      draggingRef.current = false
      setIsDragging(false)
      layoutRef.current.setNotesPreferredWidth(draggedWidthRef.current, true)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
    }
  }, [])

  function startDragging() {
    draggingRef.current = true
    setIsDragging(true)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  function toggleCollapsed() {
    animateForAWhile()
    layout.toggleNotesCollapsed()
  }

  const targetWidth = collapsed ? NOTES_RAIL : layout.notesWidth
  const shownWidth = entered ? targetWidth : 0

  // The banners and the document itself — identical in both layouts.
  const body = (
    <>
      {notice ? (
        <p
          role="status"
          className="flex items-center justify-between gap-3 border-b border-border bg-[var(--message)] px-6 py-2 text-sm text-foreground"
        >
          <span className="min-w-0">{notice}</span>
          <button type="button" className="shrink-0 underline underline-offset-2" onClick={onDismissNotice}>
            Dismiss
          </button>
        </p>
      ) : null}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="prose prose-base max-w-none min-w-0 overflow-x-hidden px-6 py-6 font-sans break-words">
          <Markdown>{content}</Markdown>
        </div>
      </div>
    </>
  )

  if (layout.notesDrawer) {
    const open = layout.notesOpen
    return (
      <>
        {open ? (
          <div
            aria-hidden
            onClick={layout.closeNotes}
            className="fixed inset-0 z-30 bg-[var(--overlay)] animate-in fade-in duration-200"
          />
        ) : null}
        <aside
          // Closed, it is off-screen: inert keeps focus and screen readers out.
          // Open, it is a modal dialog over the chat.
          aria-label="Notes"
          role={open ? "dialog" : undefined}
          aria-modal={open || undefined}
          inert={!open}
          className={`fixed inset-y-0 right-0 z-40 flex w-[min(28rem,92vw)] flex-col border-l border-border bg-[var(--sidebar)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
            // Shadow only while open — closed, it would bleed in from off-screen.
            open ? "translate-x-0 shadow-xl" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <h2 className="font-heading text-base font-medium tracking-tight">Notes</h2>
            <button
              type="button"
              onClick={layout.closeNotes}
              className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
              aria-label="Close notes"
              title="Close notes"
            >
              <X className="size-5" />
            </button>
          </div>
          {body}
        </aside>
      </>
    )
  }

  return (
    <aside
      // Named because the sidebar is also a <aside>: without this, assistive
      // tech (and any role-based query) sees two indistinguishable
      // complementary landmarks.
      aria-label="Notes"
      className="relative h-full shrink-0 overflow-hidden border-l border-border bg-[var(--sidebar)]"
      style={{
        width: shownWidth,
        opacity: entered ? 1 : 0,
        transition:
          isDragging || !animating
            ? "none"
            : `width ${ENTER_MS}ms ease-out, opacity ${ENTER_MS}ms ease-out`,
      }}
    >
      {/* Fixed inner width so content doesn't reflow while the panel slides open. */}
      <div className="flex h-full flex-col" style={{ width: targetWidth }}>
        {collapsed ? (
          <div className="flex h-full w-full flex-col items-center py-4">
            <button
              type="button"
              onClick={toggleCollapsed}
              className="rounded-md p-2 text-[var(--muted)] hover:bg-[var(--hover)]"
              aria-label="Expand notes"
              title="Expand notes"
            >
              <PanelRightOpen className="size-5" />
            </button>
          </div>
        ) : (
          <>
            <div
              onPointerDown={startDragging}
              className="absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize hover:bg-border"
            />
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <h2 className="font-heading text-base font-medium tracking-tight">Notes</h2>
              <button
                type="button"
                onClick={toggleCollapsed}
                className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
                aria-label="Collapse notes"
                title="Collapse notes"
              >
                <PanelRightClose className="size-5" />
              </button>
            </div>
            {body}
          </>
        )}
      </div>
    </aside>
  )
}
