// Everything about slides, in one dialog.
//
// An uploaded PDF is kept with the conversation — every page of it — and this
// dialog shows all of them, with a check on the ones that are in the notes.
// Ticking a page adds just that page; unticking removes just that page (it stays
// in the deck, so it can be ticked again later without uploading the PDF a
// second time). Saving sends only the difference to the server, so nothing that
// is already in the notes is redone.
//
// Choosing a new PDF opens the dialog straight into an upload ("Reading your
// slides"), then shows the whole deck with its pages ticked. Loading and errors
// live here, where the user is looking, rather than somewhere on the page behind.
// Mounted only while open, so its state starts fresh each time.
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AlertCircle, FileText, Loader2, Plus, Trash2, X } from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { SlideGrid } from "@/components/slide-grid"
import { Button } from "@/components/ui/button"
import { api, apiUrl, GENERIC_ERROR } from "@/lib/api"
import type { Slide, SlidesResult } from "@/lib/api"
import { slideCountLabel } from "@/lib/slides"

type Props = {
  conversationId: string
  /** A PDF the user just chose: kept first, then its pages are offered. Null
   *  when the dialog is only being used to manage what is already there. */
  file: File | null
  /** Called whenever the server-side slides change (an upload, a save, a deck
   *  removed). `announce` is set when pages were added, so the notes panel can
   *  say if some of them found no spot yet. */
  onChanged: (result: SlidesResult, options?: { announce?: boolean }) => void
  /** Close this and open the file chooser (also offered when an upload fails). */
  onUploadAnother: () => void
  onClose: () => void
}

type Phase =
  | { kind: "loading"; uploading: boolean }
  | { kind: "failed"; message: string }
  | { kind: "ready" }

type Group = { deckId: string | null; name: string; slides: Slide[] }

function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}

/** The slides grouped by the PDF they came from, in deck order. Slides stored
 *  before decks were kept have no deck; they share one group. */
function groupByDeck(slides: Slide[]): Group[] {
  const groups = new Map<string | null, Group>()
  for (const slide of slides) {
    let group = groups.get(slide.deck_id)
    if (!group) {
      group = { deckId: slide.deck_id, name: slide.deck_name ?? "Earlier uploads", slides: [] }
      groups.set(slide.deck_id, group)
    }
    group.slides.push(slide)
  }
  return [...groups.values()]
}

export function SlidesDialog({ conversationId, file, onChanged, onUploadAnother, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>(() =>
    file && !isPdf(file)
      ? { kind: "failed", message: "Only PDF files can be added as slides." }
      : { kind: "loading", uploading: file !== null },
  )
  const [slides, setSlides] = useState<Slide[]>([])
  // Which pages should be in the notes once saved. Starts as what is in them now
  // (plus, after an upload, every page of the new deck).
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deckToRemove, setDeckToRemove] = useState<Group | null>(null)

  // The parent's callback changes identity every render; the load below must run
  // once, so it reads the latest through a ref.
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  })

  // `alive` rather than a per-effect "cancelled" flag: React StrictMode runs
  // effects twice in development (mount, clean up, mount), and an upload must not
  // run twice — so the second run is skipped, and the result of the first must
  // still be accepted. It is only dropped if the dialog is really gone.
  const aliveRef = useRef(false)
  const startedRef = useRef(false)
  useEffect(() => {
    aliveRef.current = true
    if (!startedRef.current && !(file && !isPdf(file))) {
      startedRef.current = true
      const request = file ? api.uploadSlideDeck(conversationId, file) : api.listSlides(conversationId)
      request
        .then((result) => {
          const list = Array.isArray(result) ? result : result.slides
          if (!Array.isArray(result)) {
            // The upload happened whether or not the dialog is still open: the
            // page is told, so its slide count (and the menu) are right.
            onChangedRef.current(result)
          }
          if (!aliveRef.current) return
          const newDeck = Array.isArray(result) ? null : result.deck_id
          setSlides(list)
          // In the notes already, plus every page of a deck that was just kept.
          setSelected(new Set(list.filter((s) => s.included || (newDeck && s.deck_id === newDeck)).map((s) => s.id)))
          setPhase({ kind: "ready" })
        })
        .catch((err: unknown) => {
          if (!aliveRef.current) return
          setPhase({
            kind: "failed",
            message: err instanceof Error ? err.message : file ? "We couldn't read that PDF. Please try again." : "We couldn't load your slides. Please try again.",
          })
        })
    }
    return () => {
      aliveRef.current = false
    }
  }, [conversationId, file])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // The confirmation dialog handles its own Escape; don't close both.
      if (e.key === "Escape" && !busy && deckToRemove === null) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [busy, deckToRemove, onClose])

  const groups = useMemo(() => groupByDeck(slides), [slides])
  const includedNow = useMemo(() => new Set(slides.filter((s) => s.included).map((s) => s.id)), [slides])
  // Only the difference goes to the server — pages whose state hasn't changed
  // are never re-rendered or re-placed.
  const toAdd = [...selected].filter((id) => !includedNow.has(id))
  const toRemove = [...includedNow].filter((id) => !selected.has(id))
  const changed = toAdd.length + toRemove.length > 0

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.changeSlides(conversationId, { add: toAdd, remove: toRemove })
      onChanged(result, { announce: toAdd.length > 0 })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      setBusy(false)
    }
  }

  async function removeDeck(group: Group) {
    setDeckToRemove(null)
    if (!group.deckId) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.deleteSlideDeck(conversationId, group.deckId)
      onChanged(result)
      if (result.slides.length === 0) {
        onClose()
        return
      }
      setSlides(result.slides)
      const remaining = new Set(result.slides.map((s) => s.id))
      setSelected((prev) => new Set([...prev].filter((id) => remaining.has(id))))
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
    } finally {
      setBusy(false)
    }
  }

  function setGroup(group: Group, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const s of group.slides) {
        if (on) next.add(s.id)
        else next.delete(s.id)
      }
      return next
    })
  }

  const title =
    phase.kind === "loading" && phase.uploading
      ? "Reading your slides"
      : phase.kind === "failed"
        ? "Couldn't add these slides"
        : "Slides"

  const summary = [
    toAdd.length > 0 ? `Adding ${toAdd.length}` : null,
    toRemove.length > 0 ? `Removing ${toRemove.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] px-6 py-6"
          onClick={() => {
            if (!busy && deckToRemove === null) onClose()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="slides-dialog-title"
            className="flex max-h-full w-full max-w-3xl flex-col rounded-2xl border border-border bg-background shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative border-b border-border px-5 pt-5 pr-14 pb-4">
              <button
                type="button"
                aria-label="Close"
                title="Close"
                disabled={busy}
                onClick={onClose}
                className="absolute top-4 right-4 rounded-md p-1.5 text-[var(--muted)] outline-none hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <X className="size-5" />
              </button>
              <h2 id="slides-dialog-title" className="font-heading text-lg font-medium tracking-tight">
                {title}
              </h2>
              {phase.kind === "ready" ? (
                <>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Checked slides are in your notes. Your PDFs stay here, so you can add or remove any page
                    later without uploading again.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" onClick={onUploadAnother} disabled={busy}>
                      <Plus /> Upload another PDF
                    </Button>
                    <span className="text-sm text-[var(--muted)]" aria-live="polite">
                      {slideCountLabel(selected.size)} in your notes
                    </span>
                  </div>
                </>
              ) : file ? (
                <p className="mt-1 truncate text-sm text-[var(--muted)]">{file.name}</p>
              ) : null}
            </div>

            {phase.kind === "loading" ? (
              <div role="status" className="flex flex-col items-center gap-3 px-5 py-14 text-sm text-[var(--muted)]">
                <Loader2 className="size-6 animate-spin" />
                {phase.uploading
                  ? "Reading every page — this can take a few seconds for a long deck."
                  : "Loading your slides…"}
              </div>
            ) : null}

            {phase.kind === "failed" ? (
              <p role="alert" className="flex items-start gap-2 px-5 py-6 text-sm text-[var(--error)]">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {phase.message}
              </p>
            ) : null}

            {phase.kind === "ready" ? (
              <div className="thin-scrollbar min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
                {groups.map((group) => {
                  const inNotes = group.slides.filter((s) => selected.has(s.id)).length
                  return (
                    <section key={group.deckId ?? "earlier"} aria-label={group.name}>
                      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <FileText className="size-4 shrink-0 text-[var(--muted)]" />
                        <h3 className="min-w-0 truncate text-sm font-medium">{group.name}</h3>
                        <span className="text-sm text-[var(--muted)]">
                          {inNotes} of {group.slides.length} in your notes
                        </span>
                        <span className="ml-auto flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy || inNotes === group.slides.length}
                            onClick={() => setGroup(group, true)}
                          >
                            Select all
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy || inNotes === 0}
                            onClick={() => setGroup(group, false)}
                          >
                            Clear
                          </Button>
                          {group.deckId ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={busy}
                              onClick={() => setDeckToRemove(group)}
                              className="text-[var(--error)]"
                              aria-label={`Remove ${group.name}`}
                              title="Remove this PDF"
                            >
                              <Trash2 />
                            </Button>
                          ) : null}
                        </span>
                      </div>
                      {group.deckId === null ? (
                        <p className="mb-2 text-xs text-[var(--muted)]">
                          These were added before PDFs were kept, so they can't be added back once removed.
                        </p>
                      ) : null}
                      <SlideGrid
                        items={group.slides.map((s) => ({
                          id: s.id,
                          src: `${apiUrl}/slides/${s.id}/thumbnail`,
                          label: s.included && !s.placed ? `Page ${s.page_number} · Not placed yet` : `Page ${s.page_number}`,
                          alt: s.alt,
                        }))}
                        selected={selected}
                        onChange={setSelected}
                        disabled={busy}
                      />
                    </section>
                  )
                })}
              </div>
            ) : null}

            <div className="border-t border-border px-5 py-4">
              {error ? (
                <p role="alert" className="mb-3 flex items-start gap-1.5 text-sm text-[var(--error)]">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-3">
                {phase.kind === "ready" ? (
                  <span className="mr-auto text-sm text-[var(--muted)]" aria-live="polite">
                    {summary || "No changes"}
                  </span>
                ) : null}
                {phase.kind === "failed" && file ? (
                  <Button type="button" onClick={onUploadAnother}>
                    Choose another file
                  </Button>
                ) : null}
                {phase.kind === "ready" ? (
                  <Button type="button" onClick={() => void save()} disabled={busy || !changed}>
                    {busy ? (
                      <>
                        <Loader2 className="animate-spin" /> {toAdd.length > 0 ? "Placing slides…" : "Saving…"}
                      </>
                    ) : (
                      "Save changes"
                    )}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <ConfirmDialog
        open={deckToRemove !== null}
        title={`Remove ${deckToRemove?.name ?? "this PDF"}?`}
        description="The PDF and all of its pages are removed from this conversation, and its slides leave your notes. To use it again you'll need to upload it again."
        confirmLabel="Remove"
        destructive
        onConfirm={() => deckToRemove && void removeDeck(deckToRemove)}
        onCancel={() => setDeckToRemove(null)}
      />
    </>
  )
}
