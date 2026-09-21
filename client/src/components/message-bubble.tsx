// User turns render as a small right-aligned pill (just the transcript, no
// filename/mic tag — unless it came from a genuine file upload, which shows
// as a file chip with a "Show transcript" toggle instead of the transcript
// directly). Assistant turns are always Markdown (enforced by the system
// prompt server-side) and render as plain full-width prose — no bubble, no
// border — so notes read like content on the page rather than a chat
// message. Fresh assistant replies can optionally stream in (client-side
// reveal) so they feel like a live chat model response.
import { useLayoutEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp, FileAudio } from "lucide-react"

import { Markdown, pendingMathItalicHtml, splitIncompleteMath } from "@/components/markdown"
import type { Message } from "@/lib/api"
import { fadeMask } from "@/lib/fade"
import { useStreamReveal } from "@/lib/use-stream-reveal"

// Recordings store filename "recording.webm" as metadata (no audio upload)
// — only a genuine file upload should render as a file chip instead of its
// transcript text.
function isFileAttachment(message: Message) {
  return Boolean(message.filename && message.filename !== "recording.webm")
}

// The file chip below matches the bubble's padding and text size on purpose:
// rounded-2xl is a fixed radius, so a shorter chip clamps it into a pill and
// the corners stop looking like the other messages'.
//
// The width cap is min(32rem, 100%) rather than a plain max-w-lg (32rem):
// these bubbles sit inside flex containers that size children by
// fit-content, whose floor is the content's *min-content* width. A fixed
// 32rem cap never clamps below that floor, so on a narrow screen (or with
// the notes panel open) the bubble stays min-content-wide and overflows.
// A percentage cap clamps against the actual available width instead.
const BUBBLE_MAX_W = "max-w-[min(32rem,100%)]"

// A user message taller than this collapses behind "Show more", with the last
// lines fading out rather than being sliced off. 15rem is roughly ten lines.
const COLLAPSED_MAX_PX = 240
// Only collapse when at least a line's worth would be hidden — otherwise a
// message a few pixels over the limit would hide nothing worth a click.
const LINE_PX = 24

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

// The grey box every user turn sits in. One component so a typed message, a
// transcript and an uploaded audio file all look like the same kind of thing.
function MessageBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`min-w-0 ${BUBBLE_MAX_W} rounded-2xl bg-[var(--message)] px-4 py-2.5 text-base break-words whitespace-pre-wrap text-foreground`}
    >
      {children}
    </div>
  )
}

// The message text, collapsed behind "Show more" (bottom-left, inside the box)
// once it is taller than COLLAPSED_MAX_PX. Renders as siblings so it can go
// straight into a MessageBox, on its own or under a file header.
function CollapsibleText({ content, className }: { content: string; className?: string }) {
  const textRef = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  // Measured on the text itself: scrollHeight is the full content height
  // whether or not it is currently clipped, so this is the same answer
  // collapsed or expanded. Re-measured on resize because wrapping changes with
  // the width — opening the notes panel can turn a short message into a long one.
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_MAX_PX + LINE_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [content])

  const collapsed = overflows && !expanded

  return (
    <>
      {/* The clip and the fade are on this inner element, not the box, so the
          box's background and rounded edge stay whole and only the text fades. */}
      <div
        ref={textRef}
        className={className}
        style={collapsed ? { maxHeight: COLLAPSED_MAX_PX, overflow: "hidden", ...fadeMask({ top: false, bottom: true }) } : undefined}
      >
        {content}
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className={`mt-1 -ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm whitespace-normal text-[var(--muted)] hover:bg-foreground/5 hover:text-foreground ${FOCUS_RING}`}
        >
          {expanded ? "Show less" : "Show more"}
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      ) : null}
    </>
  )
}

function TranscriptBubble({ content }: { content: string }) {
  return (
    <MessageBox>
      <CollapsibleText content={content} />
    </MessageBox>
  )
}

// An uploaded audio file: ONE box holding the file name and, once opened, its
// transcript underneath — rather than a file chip with a second box hanging
// off it. Until the server has transcribed it there is only the name.
function FileAttachmentBubble({ message }: { message: Message }) {
  const [showTranscript, setShowTranscript] = useState(false)
  // Pending uploads have a filename but no transcript yet (server still
  // transcribing). Don't offer "Show transcript" until there's something to
  // show — expanding an empty box looked broken.
  const hasTranscript = Boolean(message.content.trim())
  return (
    <MessageBox>
      {hasTranscript ? (
        <button
          type="button"
          onClick={() => setShowTranscript((s) => !s)}
          aria-label={showTranscript ? "Hide transcript" : "Show transcript"}
          aria-expanded={showTranscript}
          className={`-mx-2 -my-1 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1 text-left whitespace-normal hover:bg-foreground/5 ${FOCUS_RING}`}
        >
          <FileAudio className="size-4 shrink-0 text-[var(--muted)]" />
          {/* min-w-0 is what lets truncate actually clip — without it this
              span's nowrap min-content width props the whole box open. */}
          <span className="min-w-0 flex-1 truncate">{message.filename}</span>
          {showTranscript ? (
            <ChevronUp className="size-4 shrink-0 text-[var(--muted)]" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-[var(--muted)]" />
          )}
        </button>
      ) : (
        <div className="flex items-center gap-2 whitespace-normal">
          <FileAudio className="size-4 shrink-0 text-[var(--muted)]" />
          <span className="min-w-0 truncate">{message.filename}</span>
        </div>
      )}
      {hasTranscript && showTranscript ? <CollapsibleText content={message.content} className="mt-2" /> : null}
    </MessageBox>
  )
}

export function MessageBubble({
  message,
  stream = false,
  onStreamTick,
  onStreamDone,
}: {
  message: Message
  /** Client-side token reveal for a freshly arrived assistant reply. */
  stream?: boolean
  onStreamTick?: () => void
  onStreamDone?: () => void
}) {
  const streaming = stream && message.role === "assistant"
  const { text: revealed, done } = useStreamReveal(
    message.content,
    streaming,
    onStreamTick,
    onStreamDone,
  )

  if (message.role === "user") {
    return (
      <div className="flex min-w-0 justify-end">
        {isFileAttachment(message) ? (
          <FileAttachmentBubble message={message} />
        ) : (
          <TranscriptBubble content={message.content} />
        )}
      </div>
    )
  }

  // break-words + scrollable code blocks: assistant Markdown can contain a
  // long URL or code line that would otherwise push the column wide.
  // Incomplete math streams as italic plain TeX in the same markdown flow,
  // then swaps to KaTeX when the closer arrives — never feed an unclosed $
  // to remark-math.
  const source =
    streaming && !done
      ? (() => {
          const { complete, pending } = splitIncompleteMath(revealed)
          return pending ? complete + pendingMathItalicHtml(pending) : complete
        })()
      : revealed

  return (
    <div className="prose prose-base w-full min-w-0 max-w-none font-heading break-words [&_pre]:overflow-x-auto">
      <Markdown>{source}</Markdown>
      {streaming && !done ? <span className="stream-caret" aria-hidden /> : null}
    </div>
  )
}
