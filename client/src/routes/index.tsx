// Empty/new-chat state — no conversation exists yet. Idle: hero + composer
// are one centered group (flex justify-center). On first send/record the
// layout switches to thread chrome — title bar, message list, composer at
// the bottom — without remounting the composer (that would drop in-flight
// submit state). ChatComposer creates the conversation on first send and
// navigates into /c/$id once the AI reply lands.
import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { ChatComposer } from "@/components/chat-composer"
import { GeneratingIndicator } from "@/components/generating-indicator"
import { MessageBubble } from "@/components/message-bubble"
import { SidebarToggle } from "@/components/sidebar-toggle"
import type { Message } from "@/lib/api"
import { useRecordingContext } from "@/lib/recording-context"

export const Route = createFileRoute("/")({
  component: NewChat,
})

function NewChat() {
  const [generating, setGenerating] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<Message | null>(null)
  // Latches true on first send/record so a failed AI call (pending cleared,
  // text restored) keeps the title + bottom composer instead of snapping
  // back to the centered idle layout.
  const [engaged, setEngaged] = useState(false)
  const recording = useRecordingContext()
  const recordingStarted = recording.isRecording && recording.isHostViewingRecording

  useEffect(() => {
    if (pendingMessage || generating || recordingStarted) setEngaged(true)
  }, [pendingMessage, generating, recordingStarted])

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {/* Idle hero has no header, so the small-screen menu button floats in the
          corner; once engaged the header below carries it instead. */}
      {!engaged ? <SidebarToggle className="absolute top-3 left-3 z-10" /> : null}
      <div
        className={`shrink-0 overflow-hidden transition-[max-height,opacity] duration-500 ease-out ${
          engaged ? "max-h-16 opacity-100" : "pointer-events-none max-h-0 opacity-0"
        }`}
      >
        <div className="flex items-center gap-2 py-4 pr-3 pl-3 md:pr-6 md:pl-6">
          {/* Only while the header is showing: collapsed, it is invisible but
              its button would still be in the tab order. */}
          {engaged ? <SidebarToggle /> : null}
          <h1 className="min-w-0 truncate font-heading text-lg font-medium tracking-tight">New conversation</h1>
        </div>
      </div>

      <div
        className={`flex min-h-0 flex-1 flex-col transition-[justify-content] duration-500 ease-out ${
          engaged ? "justify-end" : "justify-center"
        }`}
      >
        {engaged ? (
          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto w-full max-w-2xl space-y-10">
              {pendingMessage ? <MessageBubble message={pendingMessage} /> : null}
              {generating ? <GeneratingIndicator /> : null}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl shrink-0 space-y-3 px-6 pb-4 text-center">
            <h1 className="font-heading text-3xl font-medium tracking-tight">Start a new lecture</h1>
            <p className="text-base text-[var(--muted)]">
              Record or upload a clip, and notes will build here as you go.
            </p>
          </div>
        )}

        <div className={`shrink-0 ${engaged ? "" : "pb-0"}`}>
          <ChatComposer
            key="new"
            conversationId={null}
            centered={!engaged}
            onSent={() => {}}
            onSubmittingChange={setGenerating}
            onPendingMessage={setPendingMessage}
          />
        </div>
      </div>
    </div>
  )
}
