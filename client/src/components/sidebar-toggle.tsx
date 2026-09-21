// The buttons that open the sidebar and notes drawers. Each shows only while its
// panel *is* a drawer — on phones, and (the sidebar only) on mid-sized windows
// where docking it would squeeze the chat — and not at all where the panel is
// already on screen beside the chat.
import { PanelLeftOpen, PanelRightOpen } from "lucide-react"

import { useLayout } from "@/lib/layout-context"
import { useRecordingContext } from "@/lib/recording-context"

const BUTTON =
  "relative shrink-0 rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

export function SidebarToggle({ className = "" }: { className?: string }) {
  const layout = useLayout()
  const recording = useRecordingContext()
  if (!layout.sidebarDrawer) return null
  return (
    <button
      type="button"
      onClick={layout.openSidebar}
      aria-label={recording.isRecording ? "Open sidebar (recording in progress)" : "Open sidebar"}
      aria-expanded={layout.sidebarOpen}
      title="Open sidebar"
      className={`${BUTTON} ${className}`}
    >
      <PanelLeftOpen className="size-5" />
      {/* With the drawer closed the sidebar's recording widget is off-screen, so
          a recording running elsewhere would otherwise be invisible. */}
      {recording.isRecording ? (
        <span className="absolute top-1 right-1 flex size-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--error)] opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-[var(--error)]" />
        </span>
      ) : null}
    </button>
  )
}

export function NotesToggle({ className = "" }: { className?: string }) {
  const layout = useLayout()
  if (!layout.notesDrawer) return null
  return (
    <button
      type="button"
      onClick={layout.openNotes}
      aria-label="Open notes"
      aria-expanded={layout.notesOpen}
      title="Open notes"
      className={`${BUTTON} ${className}`}
    >
      <PanelRightOpen className="size-5" />
    </button>
  )
}
