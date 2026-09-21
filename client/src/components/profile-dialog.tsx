// "Your profile" — the personal context layer. Two things go to the model
// from here, and they are handled very differently:
//
//   The answers (name, occupation, level, purposes, emphasis) are compiled
//   server-side into a short third-person description of the user. That text
//   is PRIVATE — never returned to the client, never shown. It used to be
//   displayed in an editable box, which is what required a hand-edit
//   endpoint, an is_edited column, and a confirm dialog to stop a form change
//   silently overwriting it. All of that went with it.
//
//   Instructions are the user's own words, sent to the writer verbatim. They
//   skip the compiler entirely: paraphrasing a directive is how it gets
//   softened or dropped.
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { AlertCircle, Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { api, GENERIC_ERROR } from "@/lib/api"
import type { ProfileFields, UserProfileState } from "@/lib/api"

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--muted)]"

const EMPTY_FIELDS: ProfileFields = {
  occupation: "",
  background_level: "",
  education_level: "",
  notes_purpose: [],
  emphasize: [],
  instructions: "",
}

// Deliberately domain-neutral. An earlier set led with "Code", which skewed
// the whole form toward programming — these have to work for medicine, law,
// history and everything else just as well.
const BACKGROUND_LEVELS = ["New to this", "Some background", "Comfortable", "Expert"]
// Formal education, distinct from background level (familiarity with the
// subject at hand) — a PhD can be new to a topic outside their field.
const EDUCATION_LEVELS = ["High school", "Undergraduate", "Master's", "Doctorate", "Professional"]
const NOTES_PURPOSES = [
  "Lectures",
  "Online courses",
  "Research",
  "Exam prep",
  "Self-study",
  "Work",
]
const EMPHASIZE = [
  "Definitions",
  "Examples",
  "Formulas & derivations",
  "Procedures & steps",
  "Reasoning & proofs",
  "Connections between topics",
  "Key takeaways",
  "Code snippets",
]

// Matches MAX_INSTRUCTIONS_LEN on the server, which rejects anything longer
// with a 422. Bounded because this text rides on every generation call.
const INSTRUCTIONS_MAX = 600

// Normalized form state, used to tell whether anything actually changed.
// The multi-selects are sorted because toggling appends, so picking the same
// options in a different order would otherwise look like an edit. Strings are
// trimmed to match what the server stores.
function snapshot(name: string, fields: ProfileFields): string {
  return JSON.stringify({
    name: name.trim(),
    occupation: fields.occupation.trim(),
    background_level: fields.background_level,
    education_level: fields.education_level,
    notes_purpose: [...fields.notes_purpose].sort(),
    emphasize: [...fields.emphasize].sort(),
    instructions: fields.instructions.trim(),
  })
}

type Props = {
  open: boolean
  onClose: () => void
  onSaved: (profile: UserProfileState) => void
}

// Shared pill styling for the single- and multi-select answers.
function Choice({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-1.5 text-sm ${FOCUS_RING} ${
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border hover:bg-[var(--hover)]"
      }`}
    >
      {label}
    </button>
  )
}

export function ProfileDialog({ open, onClose, onSaved }: Props) {
  const [name, setName] = useState("")
  const [fields, setFields] = useState<ProfileFields>(EMPTY_FIELDS)
  // What the server last confirmed. Save stays disabled until the form
  // diverges from it.
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot("", EMPTY_FIELDS))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onClose])

  // Load fresh each time it opens, so the form reflects server state rather
  // than whatever was last typed and abandoned.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    api
      .getProfile()
      .then((p) => {
        if (cancelled) return
        setName(p.name)
        setFields({ ...EMPTY_FIELDS, ...p.fields })
        setSavedSnapshot(snapshot(p.name, { ...EMPTY_FIELDS, ...p.fields }))
      })
      .catch(() => {
        // Non-fatal — an empty form still saves fine.
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const isDirty = snapshot(name, fields) !== savedSnapshot

  if (!open) return null

  function apply(saved: UserProfileState) {
    setSavedSnapshot(snapshot(saved.name, { ...EMPTY_FIELDS, ...saved.fields }))
    onSaved(saved)
  }

  function setField<K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) {
    setError(null)
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function toggle(key: "notes_purpose" | "emphasize", value: string) {
    const current = fields[key]
    setField(key, current.includes(value) ? current.filter((v) => v !== value) : [...current, value])
  }

  // The description the server compiles from these answers is private, so
  // there is nothing to confirm before overwriting and no separate save step.
  async function handleSave() {
    setBusy(true)
    setError(null)
    try {
      apply(await api.saveProfile({ name, fields }))
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
    } finally {
      setBusy(false)
    }
  }

  async function handleClear() {
    setBusy(true)
    setError(null)
    try {
      await api.deleteProfile()
      setName("")
      setFields(EMPTY_FIELDS)
      setSavedSnapshot(snapshot("", EMPTY_FIELDS))
      onSaved({ name: "", fields: EMPTY_FIELDS, has_profile: false })
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    // Fragment, not a wrapper: the confirmations below sit OUTSIDE the
    // overlay on purpose. React portals bubble events through the React
    // tree, so a confirm nested inside the overlay would have its backdrop
    // click reach onClose and close the profile dialog too.
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] px-6"
        onClick={onClose}
      >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-dialog-title"
        className="thin-scrollbar max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="profile-dialog-title" className="font-heading text-lg font-medium tracking-tight">
              Your profile
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`-m-1 shrink-0 rounded-full p-1 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Name</span>
              <input
                className={`${FIELD} ${FOCUS_RING}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Karl"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Occupation or field</span>
              <input
                className={`${FIELD} ${FOCUS_RING}`}
                value={fields.occupation}
                onChange={(e) => setField("occupation", e.target.value)}
                placeholder="Medical student, engineer, …"
              />
            </label>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium">Education level</span>
            <div className="flex flex-wrap gap-2">
              {EDUCATION_LEVELS.map((level) => (
                <Choice
                  key={level}
                  label={level}
                  active={fields.education_level === level}
                  onClick={() =>
                    setField("education_level", fields.education_level === level ? "" : level)
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium">Background level</span>
            <div className="flex flex-wrap gap-2">
              {BACKGROUND_LEVELS.map((level) => (
                <Choice
                  key={level}
                  label={level}
                  active={fields.background_level === level}
                  // Clicking the active one clears it — otherwise there's no
                  // way back to "unset" once an answer is picked.
                  onClick={() =>
                    setField("background_level", fields.background_level === level ? "" : level)
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium">What you're using notes for</span>
            <div className="flex flex-wrap gap-2">
              {NOTES_PURPOSES.map((purpose) => (
                <Choice
                  key={purpose}
                  label={purpose}
                  active={fields.notes_purpose.includes(purpose)}
                  onClick={() => toggle("notes_purpose", purpose)}
                />
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium">Emphasize</span>
            <div className="flex flex-wrap gap-2">
              {EMPHASIZE.map((item) => (
                <Choice
                  key={item}
                  label={item}
                  active={fields.emphasize.includes(item)}
                  onClick={() => toggle("emphasize", item)}
                />
              ))}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Instructions</span>
            <textarea
              className={`thin-scrollbar resize-none ${FIELD} ${FOCUS_RING}`}
              rows={5}
              maxLength={INSTRUCTIONS_MAX}
              value={fields.instructions}
              onChange={(e) => setField("instructions", e.target.value)}
              placeholder={
                "eg. keep explanations brief and to the point."
              }
            />
            <div className="mt-1 flex items-start justify-between gap-3">
              <span className="text-xs text-[var(--muted)]">
                The AI will keep these in mind when writing the notes.
              </span>
              <span className="shrink-0 text-xs text-[var(--muted)]">
                {fields.instructions.length}/{INSTRUCTIONS_MAX}
              </span>
            </div>
          </label>

        </div>

        {error ? (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2.5 rounded-xl border border-[var(--error)]/25 bg-[var(--error-bg)] px-3.5 py-2.5 text-[var(--error)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm leading-snug break-words">{error}</p>
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={busy}
            className={`rounded text-sm text-[var(--muted)] hover:text-[var(--error)] disabled:opacity-50 ${FOCUS_RING}`}
          >
            Clear profile
          </button>
          <div className="flex gap-2">
            <Button type="button" onClick={() => void handleSave()} disabled={busy || !isDirty}>
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear your profile?"
        description="Your answers and instructions will be deleted. Notes will be written without personalization until you fill it in again."
        confirmLabel="Clear"
        destructive
        onConfirm={() => {
          setConfirmClear(false)
          void handleClear()
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </>,
    document.body
  )
}
