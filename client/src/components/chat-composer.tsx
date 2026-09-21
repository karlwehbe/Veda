// Bottom-fixed composer — record from the mic or system audio (with
// pause/resume), or attach an audio file (or slides, via the "+" menu), then send. The actual recording engine
// (MediaRecorder, the /ws/transcribe socket, live transcript, timer) lives
// in RecordingContext at the app root, not here — so it survives navigating
// away mid-recording instead of being torn down. This component is a "view"
// onto that shared state: it shows the live recording inline when it's the
// page currently hosting it (see recording.isHostViewingRecording), and a
// plain idle composer otherwise. The floating RecordingWidget covers every
// other page while a recording is in progress elsewhere.
//
// One layout everywhere: a single row (attach · text · actions) that
// stacks into two rows once the text overflows one line. The new-chat
// page and an existing conversation get the identical composer — typing
// is allowed in both, and on a new chat the first send creates the
// conversation and navigates into it (see finalizeSendText). Only the
// page shell around it (title bar, notes panel) differs.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import {
  AlertCircle,
  ArrowUp,
  AudioLines,
  FileAudio,
  Mic,
  Monitor,
  Pause,
  Play,
  Plus,
  Presentation,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { api, GENERIC_ERROR } from "@/lib/api"
import { useConversationsContext } from "@/lib/conversations-context"
import { fadeMask, useScrollFade } from "@/lib/fade"
import { useRecordingContext } from "@/lib/recording-context"
import type { MessageTurn, Message } from "@/lib/api"
import type { Source } from "@/lib/recording-context"

type Props = {
  conversationId: string | null
  // Autosaved transcript from an in-progress recording — restored into the
  // composer when revisiting a conversation after a full page reload (an
  // in-SPA navigation doesn't need this anymore, the recording just keeps
  // running in RecordingContext).
  draftTranscript?: string | null
  // New-chat idle layout centers the composer; drop the bottom padding so
  // the hero+composer group sits on the true vertical center.
  centered?: boolean
  onSent: (turn: MessageTurn) => void
  // Fires whenever a send is in flight — lets the conversation page show a
  // "Generating…" indicator in the message list instead of the button
  // itself carrying the loading state.
  onSubmittingChange?: (submitting: boolean) => void
  // Fires with the in-flight user turn the instant send starts — lets the
  // thread show the right bubble shape (file chip vs transcript) before the
  // round trip completes.
  onPendingMessage?: (message: Message | null) => void
  // Slides live in the "+" menu next to the attach action. Omitted on the
  // new-chat page, where there is no conversation (and so no notes) yet — the
  // menu item is then shown disabled rather than missing.
  slides?: SlidesMenu
}

export type SlidesMenu = {
  // Slides are placed against the notes, so this is false until they exist.
  canUpload: boolean
  count: number
  onUpload: () => void
  onManage: () => void
}

// A hover-opened popover menu anchored above its trigger. The menu is portaled
// to document.body so it isn't clipped by the chat column's own
// overflow-hidden and can render above the notes sidebar — a plain CSS-hover
// popover can't escape an ancestor's overflow. Since it's portaled, hover
// state has to be driven in JS rather than CSS :hover, and needs a short
// close-delay so moving the pointer from the trigger into the menu doesn't
// flicker it shut in the gap between them.
function useHoverMenu() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])
  const show = useCallback(() => {
    cancelClose()
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.top, left: rect.left })
    setOpen(true)
  }, [cancelClose])
  const scheduleClose = useCallback(() => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150)
  }, [])
  const close = useCallback(() => {
    cancelClose()
    setOpen(false)
  }, [cancelClose])
  useEffect(() => cancelClose, [cancelClose])

  return { open, pos, anchorRef, show, scheduleClose, close }
}

// Textarea grows with content up to this height, then becomes scrollable —
// same behavior as Claude/ChatGPT's composer.
const MAX_TEXTAREA_HEIGHT = 200

// Applied to every hand-rolled interactive element below instead of relying
// on the browser's default focus outline, which on some browsers/OSes
// renders as a yellow/gold ring that reads oddly against the white UI.
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

export function ChatComposer({
  conversationId,
  draftTranscript,
  centered = false,
  onSent,
  onSubmittingChange,
  onPendingMessage,
  slides,
}: Props) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const { refetch } = useConversationsContext()
  const recording = useRecordingContext()

  // After a first send from "/", only navigate into the new thread if this
  // composer is still mounted and the user is still on the new-chat page.
  // Otherwise a late reply would yank them back from whatever they opened
  // while waiting (the unmounted composer's pathnameRef can still say "/").
  function openNewConversationIfStillOnNewChat(targetId: string) {
    if (!aliveRef.current) return
    if (pathnameRef.current === "/") {
      void navigate({
        to: "/c/$conversationId",
        params: { conversationId: targetId },
        // Soft-open the notes panel when the first reply created one;
        // stream the assistant reply so it doesn't pop in fully formed.
        state: { animateNotesOpen: true, streamAssistant: true },
      })
    }
  }

  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A transcript recovered from the backend after a full page reload — only
  // relevant while nothing is actively recording (see recording.isRecording).
  const [restoredDraft, setRestoredDraft] = useState("")
  // When the first send creates a conversation, remember its id so a failed
  // AI call can retry against the same row instead of spawning another
  // "New conversation" (conversationId prop stays null while we remain on /).
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null)

  const sourceMenu = useHoverMenu()
  const addMenu = useHoverMenu()
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  // True while a file drag is over the composer shell — drives a small
  // scale/border pulse. Depth counter so entering child nodes doesn't flicker.
  const [fileDragOver, setFileDragOver] = useState(false)
  // Single-row until the textarea needs more than one line (or a wrapping
  // transcript is showing); then buttons move under the text.
  const [multiline, setMultiline] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const fileDragDepthRef = useRef(0)

  // Tell RecordingContext which conversation this composer is showing —
  // there's always exactly one ChatComposer mounted app-wide (every route
  // renders one), so this always reflects the current page. Drives
  // isHostViewingRecording, which decides inline-vs-widget display.
  useEffect(() => {
    recording.reportViewingConversation(conversationId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  useEffect(() => {
    onSubmittingChange?.(submitting)
  }, [submitting, onSubmittingChange])

  // Restore this conversation's autosaved draft — only matters after a full
  // page reload (RecordingContext, and any in-progress session, doesn't
  // survive that). If a recording is already live here, it already has the
  // right text; don't stomp it with a possibly-stale backend read.
  useEffect(() => {
    if (!conversationId || recording.isRecording) return
    const id = conversationId
    let cancelled = false

    if (draftTranscript?.trim()) {
      setRestoredDraft(draftTranscript.trim())
    }

    async function loadDraft() {
      try {
        const conversation = await api.getConversation(id)
        if (cancelled) return
        const draft = conversation.draft_transcript?.trim()
        if (draft) setRestoredDraft(draft)
      } catch {
        // Leave the composer empty if the fetch fails.
      }
    }

    void loadDraft()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, draftTranscript])

  async function handleStartRecording(chosenSource: Source) {
    setError(null)
    setFile(null)
    setText("")
    const seed = restoredDraft
    setRestoredDraft("")
    await recording.startRecording(conversationId, chosenSource, seed)
  }

  // Discards whatever transcript is currently showing — either the live
  // recording in progress (stops it, no send) or a draft restored from a
  // previous session — and clears the backend's autosaved copy so it can't
  // reappear on a later visit.
  function clearTranscript() {
    setError(null)
    if (isRecordingHere) {
      const { deletedConversationId } = recording.discardRecording()
      // discardRecording deletes the conversation outright if it was
      // created just for this session — if that's the one we're actually
      // looking at (its own /c/$id page, not "/"), navigate away rather
      // than leaving the user stranded on a route for a conversation that
      // no longer exists.
      if (deletedConversationId && conversationId === deletedConversationId) {
        void navigate({ to: "/" })
      }
    } else if (restoredDraft) {
      setRestoredDraft("")
      if (conversationId) {
        void api.saveDraftTranscript(conversationId, "").catch(() => { })
      }
    }
  }

  // File-upload send — audio bytes only; server batch-transcribes.
  async function finalizeSend(audio: Blob | File, name: string) {
    setSubmitting(true)
    setError(null)
    // Uploads show the file chip immediately (transcript fills in after
    // the server transcribes).
    onPendingMessage?.({
      id: "pending",
      role: "user",
      content: "",
      filename: name,
      created_at: new Date().toISOString(),
    })
    const attachedFile = file
    setFile(null)
    setText("")
    setRestoredDraft("")
    let targetId = conversationId ?? createdConversationId
    try {
      if (!targetId) {
        const conversation = await api.createConversation()
        targetId = conversation.id
        setCreatedConversationId(conversation.id)
        await refetch()
      }
      const turn = await api.sendMessage(targetId, audio, name)
      await refetch()

      if (!conversationId) {
        openNewConversationIfStillOnNewChat(targetId)
      } else {
        onPendingMessage?.(null)
        onSent(turn)
      }
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      onPendingMessage?.(null)
      if (attachedFile) setFile(attachedFile)
    } finally {
      if (aliveRef.current) setSubmitting(false)
    }
  }

  // Live recording send — transcript already captured via /ws/transcribe;
  // no audio bytes. filename marks the turn as a recording in the DB.
  async function finalizeSendLive(
    transcript: string,
    explicitConversationId: string,
  ) {
    setSubmitting(true)
    setError(null)
    onPendingMessage?.({
      id: "pending",
      role: "user",
      content: transcript,
      filename: null,
      created_at: new Date().toISOString(),
    })
    setFile(null)
    setText("")
    setRestoredDraft("")
    let targetId = explicitConversationId
    try {
      const turn = await api.sendLiveRecordingMessage(targetId, transcript)
      await refetch()

      if (!conversationId) {
        openNewConversationIfStillOnNewChat(targetId)
      } else {
        onPendingMessage?.(null)
        onSent(turn)
      }
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      onPendingMessage?.(null)
      // Restore transcript into the composer for retry. Server rolls back the
      // user row on AI failure so a retry won't duplicate.
      setRestoredDraft(transcript)
    } finally {
      if (aliveRef.current) setSubmitting(false)
    }
  }

  async function finalizeSendText(typedText: string, fromDraft = false) {
    setSubmitting(true)
    setError(null)
    onPendingMessage?.({
      id: "pending",
      role: "user",
      content: typedText,
      filename: null,
      created_at: new Date().toISOString(),
    })
    setText("")
    setRestoredDraft("")
    let targetId = conversationId ?? createdConversationId
    try {
      if (!targetId) {
        const conversation = await api.createConversation()
        targetId = conversation.id
        setCreatedConversationId(conversation.id)
        await refetch()
      }
      const turn = await api.sendTextMessage(targetId, typedText)
      await refetch()

      if (!conversationId) {
        openNewConversationIfStillOnNewChat(targetId)
      } else {
        onPendingMessage?.(null)
        onSent(turn)
      }
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      onPendingMessage?.(null)
      // Put it back where it came from: a recovered transcript returns to the
      // transcript display, typed text to the textarea. Conversation stays —
      // created on send by design; server already removed the rolled-back
      // user row so retry is clean.
      if (fromDraft) {
        setRestoredDraft(typedText)
      } else {
        setText(typedText)
      }
    } finally {
      if (aliveRef.current) setSubmitting(false)
    }
  }

  async function submit() {
    const typedText = text.trim()
    if (file) {
      await finalizeSend(file, file.name)
    } else if (typedText) {
      await finalizeSendText(typedText)
    } else if (restoredDraft.trim()) {
      // Draft-only send — a transcript recovered after a reload, with no
      // live session left to continue.
      await finalizeSendText(restoredDraft.trim(), true)
    }
  }

  // Pause and Stop used to be two separate buttons; now Stop is merged into
  // Send — clicking Send while recording (or paused) finishes the
  // recording and submits it in one action, instead of requiring a
  // dedicated stop step first.
  async function stopAndSend() {
    setSubmitting(true)
    const result = await recording.stopAndFinalize()
    if (!result) {
      setSubmitting(false)
      return
    }
    if (!result.transcript.trim()) {
      // Known empty client-side — reject immediately instead of showing a
      // pending message, hitting the server, and only then finding out (the
      // round trip was what made this look like it "sent, then bounced
      // back": a phantom bubble appeared and then vanished on the 400).
      setSubmitting(false)
      setError("We couldn't hear any speech in that recording. Please try again.")
      // Don't leave a permanent empty "New conversation" behind for a
      // recording that's being rejected before it ever reaches the server —
      // only applies if this conversation was created just for this
      // recording (started from the new-chat page); an existing
      // conversation's real history must never be touched.
      if (!conversationId) {
        try {
          await api.deleteConversation(result.conversationId)
          await refetch()
        } catch {
          // Not fatal — worst case an empty conversation lingers.
        }
      }
      return
    }
    await finalizeSendLive(result.transcript, result.conversationId)
  }

  const isRecordingHere = recording.isRecording && recording.isHostViewingRecording
  const hasAudio = Boolean(file)
  const hasTranscript = isRecordingHere ? recording.liveTranscript.trim().length > 0 : restoredDraft.trim().length > 0
  const displayTranscript = isRecordingHere ? recording.liveTranscript : restoredDraft
  // A recording already running elsewhere blocks starting a new one here —
  // only one mic session at a time. Otherwise hidden once there's other
  // content queued up (an attached file or typed text), already recording
  // here (replaced by pause/resume), or a send is in flight — stopAndFinalize
  // flips recording.isRecording false right when Send is clicked, before the
  // actual stop/send resolves, so without the !submitting check the record
  // button would flash back into view for that brief window.
  const showRecordButton = !recording.isRecording && !file && !text.trim() && !submitting
  const showTextarea = !isRecordingHere && !hasAudio && !hasTranscript && !submitting
  // Stack when the typed text wraps to a second line, or a transcript is up.
  // A file chip alone / empty "Listening…" stay single-row.
  const stacked =
    (showTextarea && (multiline || text.includes("\n"))) ||
    (hasTranscript && displayTranscript.trim().length > 0)

  // Grow the textarea with its content up to MAX_TEXTAREA_HEIGHT, then scroll.
  //
  // Stacking is decided by measuring at the *single-row* text width every
  // time — not the current layout width. Measuring at full (stacked) width
  // made long lines fit on one row → unstack → wrap again → flicker loop.
  function syncTextareaSize() {
    const el = textareaRef.current
    const shell = shellRef.current
    if (!el || !shell || !showTextarea) return

    const styles = getComputedStyle(el)
    const lineHeight = parseFloat(styles.lineHeight) || 24
    const padY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0)
    const oneLine = lineHeight + padY

    // Attach (~40) + send (~40) + gaps/padding (~32) reserved in single-row.
    const narrowTextWidth = Math.max(120, shell.clientWidth - 112)

    el.style.flex = "none"
    el.style.width = `${narrowTextWidth}px`
    el.style.maxWidth = `${narrowTextWidth}px`
    el.style.height = "auto"
    const narrowScrollH = el.scrollHeight
    const linesAtNarrow = Math.max(1, Math.round((narrowScrollH - padY) / lineHeight))

    el.style.flex = ""
    el.style.width = ""
    el.style.maxWidth = ""
    el.style.height = "auto"
    const scrollH = el.scrollHeight
    const next = Math.min(Math.max(scrollH, oneLine), MAX_TEXTAREA_HEIGHT)
    el.style.height = `${next}px`
    el.style.overflowY = scrollH > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden"
    if (scrollH > MAX_TEXTAREA_HEIGHT) {
      el.scrollTop = el.scrollHeight
    }
    return { linesAtNarrow }
  }

  useLayoutEffect(() => {
    const measured = syncTextareaSize()
    if (!measured) return
    // Once stacked, stay stacked until the field is cleared — measuring at
    // full width would otherwise unstack mid-sentence and flicker.
    const wrapped =
      Boolean(text.trim()) && (text.includes("\n") || measured.linesAtNarrow >= 2)
    setMultiline((prev) => {
      if (!text.trim()) return false
      if (wrapped || prev) return true
      return false
    })
  }, [text, showTextarea])

  // Reflow height after the single-row ↔ stacked width change — no setState.
  useLayoutEffect(() => {
    syncTextareaSize()
  }, [stacked, showTextarea])

  // A soft fade where the textarea and the transcript area clip their text
  // (both cap at 200px and scroll), instead of a hard cutoff. Declared after
  // the sizing effects above so it measures the height they just set. The
  // textarea keeps its own ref for sizing; one stable callback feeds both.
  const textFade = useScrollFade<HTMLTextAreaElement>()
  const statusFade = useScrollFade<HTMLDivElement>()
  const setTextareaEl = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      textFade.ref(node)
    },
    [textFade.ref],
  )

  // Same path as the audio file input in the "+" menu — also used by drag-and-drop onto the
  // composer shell. Reject non-audio so a stray PDF doesn't silently become
  // the "file" that Send would try to transcribe.
  function attachFile(next: File | null) {
    if (!next) return
    if (!next.type.startsWith("audio/")) {
      setError("Only audio files can be attached.")
      return
    }
    setError(null)
    setFile(next)
    setText("")
    setRestoredDraft("")
  }

  function clearFileDragOver() {
    fileDragDepthRef.current = 0
    setFileDragOver(false)
  }

  function onComposerDragEnter(e: React.DragEvent) {
    if (submitting || isRecordingHere) return
    if (![...e.dataTransfer.types].includes("Files")) return
    e.preventDefault()
    fileDragDepthRef.current += 1
    setFileDragOver(true)
  }

  function onComposerDragOver(e: React.DragEvent) {
    // Required — without preventDefault the browser won't fire drop, and
    // would navigate to the file instead.
    if (submitting || isRecordingHere) return
    if (![...e.dataTransfer.types].includes("Files")) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }

  function onComposerDragLeave(e: React.DragEvent) {
    if (![...e.dataTransfer.types].includes("Files")) return
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
    if (fileDragDepthRef.current === 0) setFileDragOver(false)
  }

  function onComposerDrop(e: React.DragEvent) {
    if (submitting || isRecordingHere) return
    e.preventDefault()
    clearFileDragOver()
    const dropped = e.dataTransfer.files?.[0] ?? null
    attachFile(dropped)
  }

  // The "+" replaces the old paperclip: hovering opens a menu of things to
  // add — an audio file to transcribe, or a slide deck. Same popover styling
  // as the record-source menu below. The audio <input> stays mounted here
  // (hidden) so the menu item can open its file chooser.
  const addButton = (
    <div
      ref={addMenu.anchorRef}
      className="relative"
      onMouseEnter={addMenu.show}
      onMouseLeave={addMenu.scheduleClose}
    >
      <button
        type="button"
        onClick={addMenu.show}
        className={`rounded-full p-2.5 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
        aria-label="Add files"
        aria-haspopup="menu"
        aria-expanded={addMenu.open}
        title="Add"
      >
        <Plus className="size-5" />
      </button>
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        aria-label="Choose an audio file"
        onChange={(e) => {
          attachFile(e.target.files?.[0] ?? null)
          // Allow re-selecting the same file after clearing.
          e.target.value = ""
        }}
      />

      {addMenu.open
        ? createPortal(
            <div
              style={{
                position: "fixed",
                top: addMenu.pos.top,
                left: addMenu.pos.left,
                transform: "translateY(-100%)",
              }}
              className="z-50 pb-2"
              onMouseEnter={addMenu.show}
              onMouseLeave={addMenu.scheduleClose}
            >
              <div
                role="menu"
                aria-label="Add files"
                className="flex flex-col gap-1.5 rounded-xl border border-border bg-background p-1 shadow-md"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    addMenu.close()
                    audioInputRef.current?.click()
                  }}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap text-foreground hover:bg-[var(--hover)] ${FOCUS_RING}`}
                >
                  <FileAudio className="size-4" />
                  Upload audio file
                </button>
                {/* One slides item, not two: once a conversation has slides,
                    "Upload slides" gives way to "Manage slides" — which has its
                    own "Add more slides" — so the menu never lists both. */}
                {slides && slides.count > 0 ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      addMenu.close()
                      slides.onManage()
                    }}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap text-foreground hover:bg-[var(--hover)] ${FOCUS_RING}`}
                  >
                    <Presentation className="size-4" />
                    Manage slides
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!slides?.canUpload}
                    title={slides?.canUpload ? undefined : "Slides can be added once notes have been generated"}
                    onClick={() => {
                      addMenu.close()
                      slides?.onUpload()
                    }}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap text-foreground hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${FOCUS_RING}`}
                  >
                    <Presentation className="size-4" />
                    Upload slides
                  </button>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )

  const statusDisplay = (
    <div
      ref={statusFade.ref}
      style={fadeMask(statusFade.edges)}
      className={`thin-scrollbar min-w-0 flex-1 text-base text-[var(--muted)] ${
        isRecordingHere || hasAudio || hasTranscript
          ? "max-h-[200px] overflow-y-auto px-2 break-words whitespace-pre-wrap"
          : "truncate px-2"
      }`}
    >
      {file ? (
        <span className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-[var(--sidebar)] py-1 pr-1 pl-2.5 text-sm text-foreground">
          <FileAudio className="size-3.5 shrink-0 text-[var(--muted)]" />
          <span className="truncate">{file.name}</span>
          <button
            type="button"
            onClick={() => {
              setError(null)
              setFile(null)
            }}
            className={`rounded-full p-0.5 text-[var(--muted)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[var(--hover)] hover:text-foreground ${FOCUS_RING}`}
            aria-label="Remove file"
            title="Remove"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ) : isRecordingHere || hasAudio || hasTranscript ? (
        displayTranscript || (recording.isPaused ? "Paused" : "Listening…")
      ) : (
        "Type or record…"
      )}
    </div>
  )

  const pauseButton = isRecordingHere ? (
    <button
      type="button"
      onClick={recording.togglePause}
      className={`rounded-full p-2.5 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
      aria-label={recording.isPaused ? "Resume recording" : "Pause recording"}
      title={recording.isPaused ? "Resume" : "Pause"}
    >
      {recording.isPaused ? <Play className="size-5" /> : <Pause className="size-5" />}
    </button>
  ) : null

  // Discards the live recording or a restored draft — not shown for a plain
  // attached file or typed text, which already have their own natural way
  // to clear (remove the file, select-all-delete).
  const clearButton = isRecordingHere || hasTranscript ? (
    <button
      type="button"
      onClick={() => setShowClearConfirm(true)}
      className={`rounded-full p-2.5 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
      aria-label="Clear transcript"
      title="Clear transcript"
    >
      <X className="size-5" />
    </button>
  ) : null

  // Only ever shown when idle (not recording) — Stop is now merged into the
  // Send button, see stopAndSend. Hovering reveals a small popover with the
  // two source choices; clicking either starts recording with that source
  // immediately. The button itself only opens that popover — it is a menu
  // trigger, not a record shortcut, so a click never starts a recording on
  // its own (only hovering used to open the menu; a click without a hover
  // first — touch, or a keyboard Enter/Space on the focused button — used to
  // fall through to starting a mic recording by default instead). The
  // popover is portaled to document.body (see useHoverMenu) so it renders
  // above everything — including the notes sidebar — instead of being
  // clipped by the chat column's overflow-hidden.
  const recordButton = (
    <div
      ref={sourceMenu.anchorRef}
      className="relative"
      onMouseEnter={sourceMenu.show}
      onMouseLeave={sourceMenu.scheduleClose}
    >
      <button
        type="button"
        onClick={sourceMenu.show}
        className={`rounded-full p-2.5 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
        aria-label="Choose recording source"
        aria-haspopup="menu"
        aria-expanded={sourceMenu.open}
        title="Record"
      >
        <AudioLines className="size-5" />
      </button>

      {sourceMenu.open
        ? createPortal(
            <div
              style={{
                position: "fixed",
                top: sourceMenu.pos.top,
                left: sourceMenu.pos.left,
                transform: "translateY(-100%)",
              }}
              className="z-50 pb-2"
              onMouseEnter={sourceMenu.show}
              onMouseLeave={sourceMenu.scheduleClose}
            >
              <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-background p-1 shadow-md">
                <button
                  type="button"
                  onClick={() => {
                    sourceMenu.close()
                    void handleStartRecording("mic")
                  }}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap text-foreground hover:bg-[var(--hover)] ${FOCUS_RING}`}
                >
                  <Mic className="size-4" />
                  Microphone
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sourceMenu.close()
                    void handleStartRecording("system")
                  }}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap text-foreground hover:bg-[var(--hover)] ${FOCUS_RING}`}
                >
                  <Monitor className="size-4" />
                  Computer audio
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )

  const sendButton = (
    <Button
      type="button"
      size="icon-lg"
      onClick={() => (isRecordingHere ? void stopAndSend() : void submit())}
      disabled={submitting || (!isRecordingHere && !hasAudio && !text.trim() && !hasTranscript)}
      aria-label={isRecordingHere ? "Stop and send" : "Send"}
      title={isRecordingHere ? "Stop and send" : "Send"}
    >
      <ArrowUp className="size-5" />
    </Button>
  )

  const displayedError = error || (isRecordingHere ? recording.error : null)

  return (
    <div
      className={`mx-auto w-full max-w-3xl px-4 md:px-6 ${
        // Clears the home-indicator bar on phones (env() is 0 elsewhere).
        centered ? "pb-0" : "pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      }`}
    >
      {displayedError ? (
        <div
          role="alert"
          className="mb-2 flex items-start gap-2.5 rounded-xl border border-[var(--error)]/25 bg-[var(--error-bg)] px-3.5 py-2.5 text-[var(--error)]"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p className="flex-1 text-sm leading-snug">{displayedError}</p>
          <button
            type="button"
            onClick={() => {
              setError(null)
              recording.clearError()
            }}
            className={`-mx-1 -mb-1 -mt-0.5 shrink-0 rounded-full p-1 hover:bg-[var(--error)]/15 ${FOCUS_RING}`}
            aria-label="Dismiss error"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div
        ref={shellRef}
        className={`rounded-2xl border border-border bg-background shadow-sm transition-[transform,border-color] duration-200 ease-out ${
          stacked ? "flex flex-col gap-1.5 px-3 pt-3 pb-2" : "flex items-center gap-1 px-2 py-2"
        } ${fileDragOver ? "composer-file-drag" : ""}`}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        {!stacked ? addButton : null}

        {showTextarea ? (
            <textarea
              ref={setTextareaEl}
              style={fadeMask(textFade.edges)}
              value={text}
            onChange={(e) => {
              setError(null)
              setText(e.target.value)
            }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder="Type or record…"
              rows={1}
            // stacked: w-full only — flex-1 in a column was shrinking the
            // box to one line and clipping earlier lines (looked like text
            // "disappeared"). single-row: flex-1 to fill between buttons.
            //
            // Empty: nowrap, so the placeholder stays on one line and simply
            // runs off the edge (clipped) as the composer narrows, instead of
            // wrapping onto a second line. A textarea's placeholder takes the
            // element's own white-space, so this is switched to pre-wrap as
            // soon as there is real text to wrap.
            className={`thin-scrollbar max-h-[200px] resize-none overflow-x-hidden break-words bg-transparent px-2 py-2.5 text-base leading-normal ${
              text ? "whitespace-pre-wrap" : "whitespace-nowrap"
            } text-foreground outline-none placeholder:text-[var(--muted)] ${
              stacked ? "w-full" : "min-w-0 flex-1"
            }`}
            />
          ) : (
            statusDisplay
          )}

        <div className={`flex shrink-0 items-center gap-1 ${stacked ? "w-full justify-between" : ""}`}>
          {stacked ? addButton : null}
          <div className={`flex items-center gap-1 ${stacked ? "ml-auto" : ""}`}>
            {clearButton}
            {isRecordingHere ? pauseButton : showRecordButton ? recordButton : null}
              {sendButton}
          </div>
        </div>
        </div>

      <ConfirmDialog
        open={showClearConfirm}
        title="Clear transcript?"
        description={
          isRecordingHere
            ? "This will stop the recording and discard the transcript. This can't be undone."
            : "This will discard the recovered transcript. This can't be undone."
        }
        confirmLabel="Clear"
        destructive
        onConfirm={() => {
          setShowClearConfirm(false)
          clearTranscript()
        }}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  )
}
