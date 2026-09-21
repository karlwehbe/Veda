// A single conversation thread — loads existing messages + notes via the
// route loader, then appends new turns / updates the notes locally as
// they're sent (no full refetch needed, just after the composer's own
// request). Layout is chat (left) + NotesPanel (right, once notes exist),
// same shape as Claude's document/artifact panel.
import { useEffect, useRef, useState } from "react"
import { createFileRoute, useRouterState } from "@tanstack/react-router"

import { ChatComposer } from "@/components/chat-composer"
import { GeneratingIndicator } from "@/components/generating-indicator"
import { MessageBubble } from "@/components/message-bubble"
import { NotesPanel } from "@/components/notes-panel"
import { NotesToggle, SidebarToggle } from "@/components/sidebar-toggle"
import { SlidesDialog } from "@/components/slides-dialog"
import { api } from "@/lib/api"
import { fadeMask, useScrollFade } from "@/lib/fade"
import { useProjectsContext } from "@/lib/projects-context"
import type { Message, SlidesResult } from "@/lib/api"

/** Set when navigating from "/" after the first reply that created notes. */
export type ConversationLocationState = {
  animateNotesOpen?: boolean
  /** Reveal the latest assistant message as a token stream on arrival. */
  streamAssistant?: boolean
}

export const Route = createFileRoute("/c/$conversationId")({
  // Always refetch on revisit — cached loader data can still have
  // draft_transcript: null from before the user started recording.
  loader: ({ params }) => api.getConversation(params.conversationId),
  staleTime: 0,
  gcTime: 0,
  component: RouteComponent,
})

// TanStack Router reuses the same ConversationThread instance across
// /c/A -> /c/B (only $conversationId changes) — without this key, its
// messages/generating/pendingMessage state, and any in-flight send's
// callbacks (onSent, onPendingMessage, onSubmittingChange), stay bound to
// whichever conversation was showing when that request started. Switch
// conversations mid-send and the response would land in the new
// conversation's view instead of the one that actually sent it. Keying by
// conversationId forces a full remount so each conversation gets a fully
// independent instance — this supersedes ChatComposer's own inner key below.
function RouteComponent() {
  const { conversationId } = Route.useParams()
  return <ConversationThread key={conversationId} />
}

function ConversationThread() {
  const conversation = Route.useLoaderData()
  const { conversationId } = Route.useParams()
  const { projects } = useProjectsContext()
  const project = projects.find((p) => p.id === conversation.project_id)
  const animateFromNav = useRouterState({
    select: (s) =>
      Boolean((s.location.state as ConversationLocationState | undefined)?.animateNotesOpen),
  })
  const streamFromNav = useRouterState({
    select: (s) =>
      Boolean((s.location.state as ConversationLocationState | undefined)?.streamAssistant),
  })
  const [messages, setMessages] = useState<Message[]>(conversation.messages)
  const [noteContent, setNoteContent] = useState<string | null>(conversation.note_content)
  // Local copy so we can clear it on send without waiting for a loader refetch
  // — otherwise a stale draftTranscript prop can restore into the composer.
  const [draftTranscript, setDraftTranscript] = useState<string | null>(conversation.draft_transcript)
  const [title, setTitle] = useState(conversation.title)
  const [slideCount, setSlideCount] = useState(conversation.slide_count)
  // The slides dialog, when open. It owns everything from here — keeping a newly
  // chosen PDF, ticking pages, loading and error states — so the route only needs
  // to know whether it is showing, and which file (if any) it was opened for.
  const [slidesDialog, setSlidesDialog] = useState<{ file: File | null } | null>(null)
  // After adding slides, a heads-up if some have no spot in the notes yet —
  // they are hidden until placed, which would otherwise look like a bug.
  const [slideNotice, setSlideNotice] = useState<string | null>(null)
  const slideInputRef = useRef<HTMLInputElement | null>(null)
  const [generating, setGenerating] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<Message | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(() => {
    if (!streamFromNav) return null
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      if (conversation.messages[i]?.role === "assistant") return conversation.messages[i]!.id
    }
    return null
  })
  const bottomRef = useRef<HTMLDivElement | null>(null)
  // Messages fade out at the bottom edge — the seam with the composer — while
  // there is more below, instead of being cut off in a straight line. No fade
  // once scrolled to the newest message, so the latest text is never dimmed.
  const threadFade = useScrollFade<HTMLDivElement>()
  // False until the first scroll-to-bottom below has run once. ConversationThread
  // remounts fresh per conversation (keyed by conversationId in RouteComponent),
  // so this naturally resets on every visit.
  const hasScrolledOnceRef = useRef(false)
  // Latch once per thread mount: animate when opening from a new-chat first
  // reply, or when this conversation had no notes yet (notes appear mid-turn).
  // Skip when opening an existing notes doc from the sidebar.
  const shouldAnimateNotesEnter = useRef(animateFromNav || !conversation.note_content).current

  useEffect(() => {
    setMessages(conversation.messages)
    setNoteContent(conversation.note_content)
    setDraftTranscript(conversation.draft_transcript)
    setTitle(conversation.title)
    setSlideCount(conversation.slide_count)
  }, [
    conversation.messages,
    conversation.note_content,
    conversation.draft_transcript,
    conversation.title,
    conversation.slide_count,
  ])

  useEffect(() => {
    // Land at the bottom instantly on the conversation's initial load —
    // animating a visible scroll down on every visit looked like the page
    // was still loading. Only smooth-scroll for later changes (a reply
    // streaming in, generating starting) while already viewing the thread.
    bottomRef.current?.scrollIntoView({ behavior: hasScrolledOnceRef.current ? "smooth" : "auto" })
    hasScrolledOnceRef.current = true
  }, [messages, generating])

  // Slides are placed against the notes, so there must be notes first — the
  // server refuses too; this just keeps the button honest.
  const canAddSlides = Boolean(noteContent)

  function applySlidesResult(result: SlidesResult, { announce = false } = {}) {
    setNoteContent(result.note_content)
    // Every page kept, in the notes or not — so "Manage slides" appears as soon
    // as a PDF is uploaded, even before any page is ticked.
    setSlideCount(result.slides.length)
    const included = result.slides.filter((s) => s.included)
    const unplaced = included.filter((s) => !s.placed).length
    setSlideNotice(
      announce && unplaced > 0
        ? `${unplaced} of ${included.length} slides ${unplaced === 1 ? "isn't" : "aren't"} in your notes yet — they'll appear once your notes cover them. Manage slides shows which.`
        : null,
    )
  }

  function openFileChooser() {
    slideInputRef.current?.click()
  }

  // No messages yet (eagerly created — e.g. "New chat" from a project page —
  // and nothing sent or recording yet): same centered hero as "/" instead of
  // an empty scroll area, until the first send/record engages the thread.
  const engaged = messages.length > 0 || pendingMessage !== null || generating

  return (
    <div className="flex h-full">
      <div data-testid="chat-column" className="flex h-full flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 py-4 pr-3 pl-3 md:gap-3 md:pr-6 md:pl-6">
          {/* Small screens only: the sidebar and notes are drawers there. */}
          <SidebarToggle />
          <h1 className="min-w-0 flex-1 truncate font-heading text-lg font-medium tracking-tight">
            {title}
          </h1>
          {noteContent ? <NotesToggle /> : null}
          <input
            ref={slideInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            aria-label="Choose a slides PDF"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Reset so choosing the same file again still fires onChange.
              e.target.value = ""
              if (file) setSlidesDialog({ file })
            }}
          />
        </div>
        <div className={`flex min-h-0 flex-1 flex-col ${engaged ? "justify-end" : "justify-center"}`}>
          {engaged ? (
            <div
              ref={threadFade.ref}
              style={fadeMask({ top: false, bottom: threadFade.edges.bottom })}
              className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6"
            >
              <div className="mx-auto w-full max-w-2xl space-y-10">
                {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    stream={m.id === streamingId}
                    onStreamTick={() => {
                      bottomRef.current?.scrollIntoView({ behavior: "auto" })
                    }}
                    onStreamDone={() => {
                      setStreamingId((id) => (id === m.id ? null : id))
                    }}
                  />
                ))}
                {pendingMessage ? <MessageBubble message={pendingMessage} /> : null}
                {generating ? <GeneratingIndicator /> : null}
                <div ref={bottomRef} />
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl shrink-0 space-y-3 px-6 pb-4 text-center">
              <h1 className="truncate font-heading text-3xl font-medium tracking-tight">
                {project ? project.name || "Untitled project" : "Start a new lecture"}
              </h1>
              <p className="text-base text-[var(--muted)]">
                Record or upload a clip, and notes will build here as you go.
              </p>
            </div>
          )}

          <div className="shrink-0">
            <ChatComposer
              conversationId={conversationId}
              slides={{
                canUpload: canAddSlides,
                count: slideCount,
                onUpload: openFileChooser,
                onManage: () => setSlidesDialog({ file: null }),
              }}
              centered={!engaged}
              draftTranscript={draftTranscript}
              onSubmittingChange={setGenerating}
              onPendingMessage={setPendingMessage}
              onSent={(turn) => {
                setMessages((prev) => [...prev, turn.user_message, turn.assistant_message])
                setNoteContent(turn.note_content)
                setSlideCount(turn.slide_count)
                setDraftTranscript(null)
                if (turn.title) setTitle(turn.title)
                setStreamingId(turn.assistant_message.id)
              }}
            />
          </div>
        </div>
      </div>

      {noteContent ? (
        <NotesPanel
          content={noteContent}
          animateEnter={shouldAnimateNotesEnter}
          notice={slideNotice}
          onDismissNotice={() => setSlideNotice(null)}
        />
      ) : null}

      {slidesDialog ? (
        <SlidesDialog
          conversationId={conversationId}
          file={slidesDialog.file}
          onChanged={applySlidesResult}
          onUploadAnother={() => {
            setSlidesDialog(null)
            openFileChooser()
          }}
          onClose={() => setSlidesDialog(null)}
        />
      ) : null}
    </div>
  )
}
