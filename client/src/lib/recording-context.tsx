// Owns the actual recording engine (MediaRecorder, the /ws/transcribe
// socket, the live transcript, a Web Audio analyser for the waveform, and
// the elapsed-time clock) at the app root — above the router — so a
// recording keeps running no matter which page is on screen. ChatComposer
// used to own all of this locally, which meant navigating away mid-recording
// tore the whole session down. Sending itself still happens wherever the
// user actually clicks Send (ChatComposer, via stopAndFinalize()) — this
// context only owns the "is a mic live right now" engine, not the API call.
import { createContext, useContext, useEffect, useRef, useState } from "react"

import { api, wsApiUrl } from "@/lib/api"
import { useConversationsContext } from "@/lib/conversations-context"

export type Source = "mic" | "system"

type FinalizedRecording = { transcript: string; conversationId: string }

type RecordingContextValue = {
  isRecording: boolean
  isPaused: boolean
  elapsedSeconds: number
  liveTranscript: string
  error: string | null
  source: Source
  // The conversation this recording session is (or will be) attached to —
  // resolved once created, even if it started from the new-chat page with
  // no id yet.
  recordingConversationId: string | null
  // The page currently showing this recording's own composer inline (the
  // page the user was on when they clicked record, or has since navigated
  // back to) — everywhere else shows the floating widget instead.
  isHostViewingRecording: boolean
  // seedTranscript: continue on top of a previously-restored draft (e.g.
  // recovered after a full page reload) instead of starting from empty.
  startRecording: (conversationId: string | null, source: Source, seedTranscript?: string) => Promise<void>
  togglePause: () => void
  // Stops the recorder and resolves once the final transcript is ready —
  // the caller (ChatComposer) does the actual api.sendLiveRecordingMessage.
  stopAndFinalize: () => Promise<FinalizedRecording | null>
  // Throws away the in-progress recording — no send, no leftover draft (and
  // no leftover empty conversation if it was created just for this session).
  // Returns the id of a conversation it deleted outright, if any — the
  // caller should navigate away if that's the conversation it's showing.
  discardRecording: () => { deletedConversationId: string | null }
  // Called by whichever ChatComposer is currently mounted (there's always
  // exactly one, for either "/" or "/c/$id") to report what it's showing —
  // drives isHostViewingRecording / the widget's visibility.
  reportViewingConversation: (conversationId: string | null) => void
  // Dismisses the current recording-level error (e.g. the composer's error
  // banner's dismiss button) without otherwise touching the session.
  clearError: () => void
}

// How long a draft save waits before actually sending, so several triggers
// arriving close together (a burst of short finals) land in one request
// instead of one each. Small enough that the worst-case unsaved window on a
// crash barely changes; see scheduleDraftSave.
const DRAFT_SAVE_DEBOUNCE_MS = 1500

// The browser's default MediaRecorder bitrate is tuned for general audio, well
// above what a single spoken voice needs. Speech intelligibility holds up fine
// well below this; audio is by far the largest thing this feature streams
// (megabytes over a session, versus kilobytes for transcript/draft traffic), so
// this is the highest-leverage bandwidth cut available here.
const RECORDING_AUDIO_BITRATE = 32_000

// A failed draft save is retried automatically with exponential backoff —
// otherwise it only gets folded into whatever the next final/pause happens to
// send, which may never come. Capped, not capped-attempts: a dropped
// connection can come back at any point in a long recording, so it keeps
// trying at the ceiling rather than giving up.
const DRAFT_SAVE_RETRY_BASE_MS = 2_000
const DRAFT_SAVE_RETRY_MAX_MS = 30_000

// Full jitter (pick uniformly between 0 and the exponential delay, rather
// than a fixed schedule) matters once this runs for many concurrent users:
// a shared blip — a deploy, a brief DB hiccup — would otherwise have every
// affected client retry at the exact same moments, turning a brief outage
// into a synchronized wave of retries hitting the server back at once.
function nextDraftRetryDelayMs(attempt: number): number {
  const ceiling = Math.min(DRAFT_SAVE_RETRY_MAX_MS, DRAFT_SAVE_RETRY_BASE_MS * 2 ** attempt)
  return Math.random() * ceiling
}

const RecordingContext = createContext<RecordingContextValue | null>(null)

// Split out from RecordingContext on purpose: this updates every 100ms while
// recording (driving the widget's waveform), and a context value that
// changes that often would re-render every consumer of useRecordingContext —
// including ChatComposer, which never reads it — 10 times a second for the
// whole duration of every recording. Only RecordingWidget subscribes here.
const AudioLevelContext = createContext<number>(0)

// getDisplayMedia is the only browser API that can hand back computer/tab
// audio — there's no permission prompt for "just system audio," the browser
// requires requesting screen/tab sharing (with video) and lets the audio
// come along with it. We immediately stop the video track and keep only
// the audio, so nothing is actually recorded/shown from the screen share.
// getUserMedia/getDisplayMedia failures surface as DOMExceptions whose
// default .message is inconsistent and often fairly cryptic across browsers
// (e.g. Chrome's NotAllowedError message is a full sentence about user
// agents and platforms) — map the common ones to something someone using
// the app would actually understand.
//
// Which source was asked for matters: for computer audio a NotAllowedError
// usually just means the share prompt was dismissed, and "microphone access was
// denied" would be wrong. Anything unrecognised gets a plain sentence, never the
// browser's own wording.
function friendlyRecordingError(err: unknown, source: Source): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return source === "system"
          ? "Sharing wasn't allowed. Choose a tab or screen to share, and allow it to include audio."
          : "Microphone access was denied. Check your browser's site permissions and try again."
      case "NotFoundError":
        return "No microphone was found. Check that one is connected and try again."
      case "NotReadableError":
        return "Couldn't access the microphone. It may already be in use by another app."
    }
  }
  // Our own errors (like the "no system audio was shared" one below) are already
  // written for people; anything else is not.
  return err instanceof Error && err instanceof CaptureError ? err.message : "Couldn't start recording. Please try again."
}

/** An error whose message is written for the person using the app. */
class CaptureError extends Error {}

async function captureSystemAudio(): Promise<MediaStream> {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  const audioTracks = displayStream.getAudioTracks()
  displayStream.getVideoTracks().forEach((track) => track.stop())
  if (audioTracks.length === 0) {
    audioTracks.forEach((track) => track.stop())
    throw new CaptureError(
      'No system audio was shared. When prompted, share a tab or your entire screen and check "Share audio."'
    )
  }
  return new MediaStream(audioTracks)
}

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const { refetch } = useConversationsContext()

  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [liveTranscript, setLiveTranscript] = useState("")
  const [audioLevel, setAudioLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<Source>("mic")
  const [hostKey, setHostKey] = useState<string | null>(null)
  // The identity a recording session is compared against for "is the user
  // looking at it" — fixed at start (null if begun on the new-chat page, or
  // the conversation's id if begun inside an existing conversation) and
  // never changed afterward, even once a pending "/" recording gets a real
  // conversation id. See isHostViewingRecording below for why both this and
  // the resolved id are checked.
  //
  // Kept as both a ref and mirrored state: recorder.onstop's closure (set up
  // inside startRecording) needs the ref to avoid reading a stale value from
  // whatever render was current when that closure was created; render
  // (isHostViewingRecording below) needs the state, since reading a ref
  // during render doesn't reliably re-trigger when it changes.
  const sessionIdentityRef = useRef<string | null>(null)
  const [sessionIdentity, setSessionIdentity] = useState<string | null>(null)
  const [recordingConversationId, setRecordingConversationId] = useState<string | null>(null)
  // Once true, hostKey matching sessionIdentity's original null no longer
  // counts as "viewing this recording" — only an exact match against the
  // resolved recordingConversationId does. Without this, a recording begun
  // on "/" would incorrectly resurface inline any time the user later
  // revisits "/" (e.g. clicking "New chat"), since bare "/" always reports
  // hostKey = null — even after they've clearly moved on to a different,
  // unrelated conversation in between. Retired the moment hostKey stops
  // matching either identity (i.e. the user visits something else).
  const [nullHostRetired, setNullHostRetired] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const finalTranscriptRef = useRef("")
  const interimTranscriptRef = useRef("")
  // How many characters of finalTranscriptRef the server has confirmed
  // saved — lets performSave append just the new tail instead of resending
  // everything. Left alone on a failed save, so the unsent text is simply
  // included in the next attempt rather than lost (the same self-healing
  // property a full resend had). Reset to 0 wherever finalTranscriptRef
  // itself is reset to start a fresh session.
  const savedThroughRef = useRef(0)
  // Serializes saves so at most one appendDraftTranscript call is ever in
  // flight: savingRef marks that one's running, retryNeededRef records that
  // something else arrived while it was busy. No separate queue of chunks is
  // needed — a retry just calls performSave again, which recomputes the
  // chunk live from the current refs, so it naturally picks up everything
  // that accumulated in the meantime.
  const savingRef = useRef(false)
  const retryNeededRef = useRef(false)
  // Batches saves triggered close together (e.g. several finals in a quick
  // burst of speech) into one request instead of one per trigger — see
  // scheduleDraftSave. Bounded rather than a sliding debounce: it does not
  // reset on every new trigger, so the worst-case delay is always this one
  // constant, however long the burst goes on.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Consecutive draft-save failures since the last success — drives the
  // exponential backoff delay; a scheduled retry timer, separate from
  // saveTimeoutRef's batching delay.
  const draftRetryAttemptRef = useRef(0)
  const draftRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingConversationIdRef = useRef<string | null>(null)
  const allowDraftSaveRef = useRef(true)
  const stopResolveRef = useRef<((result: FinalizedRecording | null) => void) | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function updateLiveDisplay() {
    setLiveTranscript([finalTranscriptRef.current, interimTranscriptRef.current].filter(Boolean).join(" "))
  }

  // The actual network call — single-flight (see savingRef's comment above).
  // Called either after scheduleDraftSave's delay, or immediately by
  // flushDraftSave. Not called directly from anywhere else; go through one
  // of those two so bursts of triggers get batched.
  function performSave() {
    if (!allowDraftSaveRef.current) return
    // Never run two saves at once — a final arriving mid-save would otherwise
    // compute its own chunk from the same not-yet-advanced savedThroughRef,
    // overlapping with the one already in flight. Just flag that a retry is
    // owed once the current save settles.
    if (savingRef.current) {
      retryNeededRef.current = true
      return
    }
    const targetId = recordingConversationId ?? pendingConversationIdRef.current
    // Only the newest final text plus whatever's currently interim — interim
    // isn't confirmed yet (it can still change), so it's never folded into
    // savedThroughRef and gets resent, as part of the next chunk, once it
    // finalizes or the transcript stops changing.
    const newFinal = finalTranscriptRef.current.slice(savedThroughRef.current)
    const chunk = [newFinal, interimTranscriptRef.current].filter(Boolean).join(" ").trim()
    if (!targetId || !chunk) return
    const confirmsThrough = finalTranscriptRef.current.length
    savingRef.current = true
    // savedThroughRef only advances once this call's chunk is confirmed saved
    // (not optimistically at send time), so a failed save is naturally
    // resent as part of the next attempt.
    void api.appendDraftTranscript(targetId, chunk)
      .then(() => {
        savedThroughRef.current = confirmsThrough
        draftRetryAttemptRef.current = 0
        // A natural trigger's save can succeed and make an already-scheduled
        // backoff retry (from an earlier failure) redundant — cancel it
        // rather than let it fire and find nothing left to send.
        if (draftRetryTimeoutRef.current) {
          clearTimeout(draftRetryTimeoutRef.current)
          draftRetryTimeoutRef.current = null
        }
      })
      .catch((err) => {
        console.error("Failed to save draft transcript", err)
        const attempt = draftRetryAttemptRef.current
        draftRetryAttemptRef.current = attempt + 1
        if (draftRetryTimeoutRef.current) clearTimeout(draftRetryTimeoutRef.current)
        draftRetryTimeoutRef.current = setTimeout(() => {
          draftRetryTimeoutRef.current = null
          performSave()
        }, nextDraftRetryDelayMs(attempt))
      })
      .finally(() => {
        savingRef.current = false
        if (retryNeededRef.current) {
          retryNeededRef.current = false
          // Immediate, not scheduleDraftSave — this is catching up on text
          // that arrived while busy, not a fresh burst to batch.
          performSave()
        }
      })
  }

  // Called after each final: schedules a save rather than sending right away,
  // so several finals landing in a quick burst share one request. Bounded,
  // not a resetting debounce — a call while one is already scheduled changes
  // nothing (the pending save will pick up the new text too, once it fires),
  // so the delay never grows past DRAFT_SAVE_DEBOUNCE_MS regardless of how
  // long the burst continues.
  function scheduleDraftSave() {
    if (saveTimeoutRef.current) return
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null
      performSave()
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }

  // Saves right away, skipping any pending batch delay — for triggers that
  // are already infrequent on their own (pausing), where there's nothing to
  // batch and no reason to wait.
  function flushDraftSave() {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    performSave()
  }

  // Elapsed-time clock — only ticks while actually recording and unpaused.
  useEffect(() => {
    if (!isRecording || isPaused) return
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [isRecording, isPaused])

  // See nullHostRetired's comment above.
  useEffect(() => {
    if (!isRecording) return
    if (hostKey !== sessionIdentity && hostKey !== recordingConversationId) {
      setNullHostRetired(true)
    }
  }, [hostKey, isRecording, sessionIdentity, recordingConversationId])

  function stopAudioLevelMeter() {
    if (levelIntervalRef.current) {
      clearInterval(levelIntervalRef.current)
      levelIntervalRef.current = null
    }
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    analyserRef.current = null
    setAudioLevel(0)
  }

  function startAudioLevelMeter(stream: MediaStream) {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioCtx = new AudioCtx()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    audioCtxRef.current = audioCtx
    analyserRef.current = analyser

    const data = new Uint8Array(analyser.frequencyBinCount)
    levelIntervalRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sumSquares += v * v
      }
      const rms = Math.sqrt(sumSquares / data.length)
      setAudioLevel(Math.min(1, rms * 4))
    }, 100)
  }

  async function startRecording(conversationId: string | null, chosenSource: Source, seedTranscript?: string) {
    if (isRecording) return
    setError(null)
    setSource(chosenSource)
    sessionIdentityRef.current = conversationId
    setSessionIdentity(conversationId)
    setNullHostRetired(false)
    pendingConversationIdRef.current = null
    setRecordingConversationId(conversationId)
    finalTranscriptRef.current = seedTranscript?.trim() ?? ""
    // A seed transcript is a previously-restored draft, already sitting in
    // draft_transcript on the server — mark it as already saved so the first
    // append sends only genuinely new speech, not the whole seed again.
    savedThroughRef.current = finalTranscriptRef.current.length
    savingRef.current = false
    retryNeededRef.current = false
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    draftRetryAttemptRef.current = 0
    if (draftRetryTimeoutRef.current) {
      clearTimeout(draftRetryTimeoutRef.current)
      draftRetryTimeoutRef.current = null
    }
    interimTranscriptRef.current = ""
    updateLiveDisplay()
    setElapsedSeconds(0)
    allowDraftSaveRef.current = true

    let stream: MediaStream | null = null
    try {
      stream =
        chosenSource === "system"
          ? await captureSystemAudio()
          : await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Treat it as a new chat immediately rather than waiting for Send, so
      // it shows up in the sidebar (and at the top of the new-chat page) as
      // "New conversation" right away.
      if (!conversationId) {
        const conversation = await api.createConversation()
        pendingConversationIdRef.current = conversation.id
        setRecordingConversationId(conversation.id)
        void refetch()
      }

      startAudioLevelMeter(stream)

      // conversation_id is purely for the server's logs — lets a whole
      // recording be traced end to end (session start -> Deepgram connect ->
      // .../messages request) by grepping one id, instead of the live-
      // transcription proxy's logs being unattributable to any conversation.
      const targetConversationId = conversationId ?? pendingConversationIdRef.current
      const wsUrl = targetConversationId
        ? `${wsApiUrl}/ws/transcribe?conversation_id=${encodeURIComponent(targetConversationId)}`
        : `${wsApiUrl}/ws/transcribe`
      const ws = new WebSocket(wsUrl)
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data) as { transcript: string; is_final: boolean }
        if (!data.transcript) return
        if (data.is_final) {
          finalTranscriptRef.current = [finalTranscriptRef.current, data.transcript].filter(Boolean).join(" ")
          interimTranscriptRef.current = ""
          scheduleDraftSave()
        } else {
          interimTranscriptRef.current = data.transcript
        }
        updateLiveDisplay()
      }
      ws.onerror = () => {
        setError("The live transcript lost its connection. Your recording continues, but the transcript may stop updating.")
      }
      wsRef.current = ws

      // Wait for the socket to actually be open before recording starts.
      // MediaRecorder's very first chunk carries the container header every
      // later chunk needs to be decodable — if it's generated and dropped
      // before the socket finishes connecting (very likely, since chunks
      // start flowing almost immediately), Deepgram can never decode
      // anything sent after it either, so no transcript ever appears.
      await new Promise<void>((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) {
          resolve()
          return
        }
        const onOpen = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error("Couldn't connect to live transcription. Please try again."))
        }
        function cleanup() {
          ws.removeEventListener("open", onOpen)
          ws.removeEventListener("error", onError)
        }
        ws.addEventListener("open", onOpen, { once: true })
        ws.addEventListener("error", onError, { once: true })
      })

      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: RECORDING_AUDIO_BITRATE })
      // Chunks go only to Deepgram live — no in-memory blob for upload.
      // File uploads are a separate path that attaches a user-picked file.
      recorder.ondataavailable = (e) => {
        if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
          ws.send(e.data)
        }
      }
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop())
        stopAudioLevelMeter()
        // Give Deepgram a moment to flush its last final result before we
        // close our end — closing immediately can cut off the tail end.
        setTimeout(() => {
          if (wsRef.current === ws) {
            ws.onmessage = null
            ws.close()
            wsRef.current = null
          }
        }, 800)

        const resolve = stopResolveRef.current
        stopResolveRef.current = null
        const finalConversationId = sessionIdentityRef.current ?? pendingConversationIdRef.current
        // Include whatever's still sitting in interim at the exact moment of
        // stop — Deepgram may not have finalized the last word(s) yet, and
        // that text was previously dropped outright rather than sent.
        const transcript = [finalTranscriptRef.current, interimTranscriptRef.current].filter(Boolean).join(" ")
        resolve?.(finalConversationId ? { transcript, conversationId: finalConversationId } : null)
      }
      recorder.start(250)
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setIsPaused(false)
    } catch (err) {
      wsRef.current?.close()
      wsRef.current = null
      stream?.getTracks().forEach((track) => track.stop())
      stopAudioLevelMeter()
      setError(friendlyRecordingError(err, chosenSource))
      setIsRecording(false)
    }
  }

  function togglePause() {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    if (recorder.state === "paused") {
      recorder.resume()
      setIsPaused(false)
    } else {
      recorder.pause()
      setIsPaused(true)
      flushDraftSave()
    }
  }

  function stopAndFinalize(): Promise<FinalizedRecording | null> {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current
      if (!recorder || recorder.state === "inactive") {
        resolve(null)
        return
      }
      // Late Deepgram finals must not resurrect draft_transcript once the
      // server clears it on a successful send.
      allowDraftSaveRef.current = false
      stopResolveRef.current = resolve
      recorder.stop()
      setIsRecording(false)
      setIsPaused(false)
    })
  }

  // Discards the in-progress recording entirely — no send. Stops the
  // recorder/stream/analyser, wipes the live transcript, and either deletes
  // the conversation outright (if it was created just for this session and
  // nothing was ever sent to it — otherwise it'd sit in the sidebar forever
  // as a permanent empty "New conversation") or just clears its autosaved
  // draft (if it's an existing conversation with real history, which must
  // never be touched). allowDraftSaveRef + detaching onmessage up front
  // matter for the same reason they do in stopAndFinalize: a Deepgram final
  // already in flight could otherwise land after the clear and resurrect
  // exactly what this was supposed to throw away.
  function discardRecording() {
    allowDraftSaveRef.current = false
    const targetId = recordingConversationId ?? pendingConversationIdRef.current
    const wasCreatedForThisSession = sessionIdentityRef.current === null
    if (wsRef.current) {
      wsRef.current.onmessage = null
    }
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== "inactive") {
      recorder.stop()
    } else {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      stopAudioLevelMeter()
    }
    finalTranscriptRef.current = ""
    savedThroughRef.current = 0
    savingRef.current = false
    retryNeededRef.current = false
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    draftRetryAttemptRef.current = 0
    if (draftRetryTimeoutRef.current) {
      clearTimeout(draftRetryTimeoutRef.current)
      draftRetryTimeoutRef.current = null
    }
    interimTranscriptRef.current = ""
    setLiveTranscript("")
    setIsRecording(false)
    setIsPaused(false)
    setElapsedSeconds(0)
    sessionIdentityRef.current = null
    setSessionIdentity(null)
    setRecordingConversationId(null)
    pendingConversationIdRef.current = null
    if (!targetId) return { deletedConversationId: null }
    if (wasCreatedForThisSession) {
      void api
        .deleteConversation(targetId)
        .then(() => refetch())
        .catch((err) => {
          console.error("Failed to delete discarded conversation", err)
        })
      return { deletedConversationId: targetId }
    }
    void api.saveDraftTranscript(targetId, "").catch((err) => {
      console.error("Failed to clear draft transcript", err)
    })
    return { deletedConversationId: null }
  }

  const isHostViewingRecording =
    isRecording && (hostKey === recordingConversationId || (!nullHostRetired && hostKey === sessionIdentity))

  const value: RecordingContextValue = {
    isRecording,
    isPaused,
    elapsedSeconds,
    liveTranscript,
    error,
    source,
    recordingConversationId,
    isHostViewingRecording,
    startRecording,
    togglePause,
    stopAndFinalize,
    discardRecording,
    reportViewingConversation: setHostKey,
    clearError: () => setError(null),
  }

  return (
    <RecordingContext value={value}>
      <AudioLevelContext value={audioLevel}>{children}</AudioLevelContext>
    </RecordingContext>
  )
}

export function useRecordingContext() {
  const ctx = useContext(RecordingContext)
  if (!ctx) {
    throw new Error("useRecordingContext must be used within RecordingProvider")
  }
  return ctx
}

// Separate hook on purpose — see AudioLevelContext above. Only
// RecordingWidget should use this; anything that also needs the rest of the
// recording state should call useRecordingContext() alongside it.
export function useAudioLevel() {
  return useContext(AudioLevelContext)
}
