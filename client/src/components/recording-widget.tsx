// "Recording in progress elsewhere" indicator, shown whenever a recording is
// active but the user has navigated away from the conversation it belongs to.
// No send button here on purpose: sending only ever happens from the
// conversation's own composer, once the user comes back to it. Clicking the
// widget (outside the pause button) jumps straight back to that conversation.
//
// Lives *inside* the sidebar, directly above the profile row. It used to be
// portalled to document.body as a `fixed bottom-6 left-6` card, which sat on
// top of the profile row and covered it while recording.
import { useNavigate } from "@tanstack/react-router"
import { Pause, Play } from "lucide-react"

import { useAudioLevel, useRecordingContext } from "@/lib/recording-context"

// Per-bar weighting so the waveform doesn't pulse as one flat block — each
// bar reacts to the same audio level a little differently. The weights are
// deliberately uneven rather than a smooth curve, which reads as a waveform
// instead of a bell shape.
//
// Ten bars at w-1 with gap-0.5 is 58px, which fits the 256px sidebar
// alongside the dot, pause button and timer with room to spare.
const BAR_WEIGHTS = [0.3, 0.4, 0.5, 0.6, 0.85, 0.75, 1, 0.8, 1, 0.6, 0.6, 0.5, 0.5, 0.4]
const BAR_MAX_HEIGHT = 20

function formatElapsed(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

function LiveDot() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--error)] opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-[var(--error)]" />
    </span>
  )
}

export function RecordingWidget({ collapsed = false }: { collapsed?: boolean }) {
  const recording = useRecordingContext()
  const audioLevel = useAudioLevel()
  const navigate = useNavigate()

  if (!recording.isRecording || recording.isHostViewingRecording) return null

  const targetId = recording.recordingConversationId
  const elapsed = formatElapsed(recording.elapsedSeconds)

  function goToRecording() {
    if (targetId) void navigate({ to: "/c/$conversationId", params: { conversationId: targetId } })
  }

  // Collapsed rail is 56px wide — only the dot fits, so the waveform and
  // timer are dropped and the elapsed time moves into the tooltip.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={goToRecording}
        className="flex items-center justify-center rounded-md p-2 hover:bg-[var(--hover)]"
        aria-label={`Recording in progress, ${elapsed}. Go to that conversation`}
        title={`Recording — ${elapsed}`}
      >
        <LiveDot />
      </button>
    )
  }

  return (
    <div
      role="status"
      aria-label="Recording in progress"
      onClick={goToRecording}
      // pr-5 (not pl-2.5's plain 10px) on purpose: the dot's size-7 box below
      // adds 10px of its own centering space on top of the row's own left
      // padding, so the visible dot sits 20px in from the edge — matching
      // that on the right (10 + 10) is what actually centers the timer's
      // text against it, instead of both sides sharing the same raw padding
      // value but not the same visual inset.
      className={`flex items-center gap-1 rounded-md py-2 pl-2.5 pr-5 ${
        targetId ? "cursor-pointer hover:bg-[var(--sidebar-accent)]" : ""
      }`}
    >
      {/* The dot sits in a size-7 box — the same footprint as the profile
          row's avatar directly below. Both already start 18px from the
          sidebar edge, but an 8px dot and a 28px avatar only share a *left*
          edge; the eye lines them up by centre, so without this the dot reads
          as indented differently from the avatar. */}
      <span className="flex size-7 shrink-0 items-center justify-center">
        <LiveDot />
      </span>

      <button
        type="button"
        onClick={(e) => {
          // The wrapper navigates away; pausing must not also do that.
          e.stopPropagation()
          recording.togglePause()
        }}
        className="shrink-0 rounded-full p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
        aria-label={recording.isPaused ? "Resume recording" : "Pause recording"}
        title={recording.isPaused ? "Resume" : "Pause"}
      >
        {recording.isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
      </button>

      {/* Layout of the waveform, each part load-bearing:
          flex-1          claims the space between the pause button and timer
          justify-center  centres the bars in it, timer stays pinned right
          pr-2            shrinks the centring box, nudging the bars slightly
                          left of dead centre so they don't crowd the timer
          items-center    bars grow symmetrically about the row's centre line;
                          items-end would hang them below it, which reads as
                          the waveform being misaligned with the dot and timer
          min-w-0         the bars, not the timer, give way if space runs out */}
      <div
        className="flex h-5 min-w-0 flex-1 items-center justify-center gap-0.5 pr-2"
        aria-hidden="true"
      >
        {BAR_WEIGHTS.map((weight, i) => {
          const level = recording.isPaused ? 0.1 : Math.max(0.1, audioLevel * weight)
          return (
            <span
              key={i}
              className="w-1 shrink-0 rounded-full bg-[var(--accent)] transition-all duration-100 ease-out"
              style={{ height: `${Math.round(level * BAR_MAX_HEIGHT)}px` }}
            />
          )
        })}
      </div>

      <span className="shrink-0 text-sm text-[var(--muted)] tabular-nums">{elapsed}</span>
    </div>
  )
}
