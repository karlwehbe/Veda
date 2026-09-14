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
import { api } from "@/lib/api"
import { useProjectsContext } from "@/lib/projects-context"
import type { Message } from "@/lib/api"

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
  }, [conversation.messages, conversation.note_content, conversation.draft_transcript, conversation.title])

  useEffect(() => {
    // Land at the bottom instantly on the conversation's initial load —
    // animating a visible scroll down on every visit looked like the page
    // was still loading. Only smooth-scroll for later changes (a reply
    // streaming in, generating starting) while already viewing the thread.
    bottomRef.current?.scrollIntoView({ behavior: hasScrolledOnceRef.current ? "smooth" : "auto" })
    hasScrolledOnceRef.current = true
  }, [messages, generating])

  // No messages yet (eagerly created — e.g. "New chat" from a project page —
  // and nothing sent or recording yet): same centered hero as "/" instead of
  // an empty scroll area, until the first send/record engages the thread.
  const engaged = messages.length > 0 || pendingMessage !== null || generating

  return (
    <div className="flex h-full">
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <div className="py-4 pr-6 pl-6">
          <h1 className="truncate font-heading text-lg font-medium tracking-tight">
            {title}
          </h1>
        </div>
        <div className={`flex min-h-0 flex-1 flex-col ${engaged ? "justify-end" : "justify-center"}`}>
          {engaged ? (
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6">
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
              centered={!engaged}
              draftTranscript={draftTranscript}
              onSubmittingChange={setGenerating}
              onPendingMessage={setPendingMessage}
              onSent={(turn) => {
                setMessages((prev) => [...prev, turn.user_message, turn.assistant_message])
                setNoteContent(turn.note_content)
                setDraftTranscript(null)
                if (turn.title) setTitle(turn.title)
                setStreamingId(turn.assistant_message.id)
              }}
            />
          </div>
        </div>
      </div>

      {noteContent ? (
        <NotesPanel content={noteContent} animateEnter={shouldAnimateNotesEnter} />
      ) : null}
    </div>
  )
}
