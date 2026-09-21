// Modal for creating OR editing a project — same four fields (name, type,
// description, instructions) either way. Passing `project` switches it into
// edit mode: prefilled, saves with PUT instead of POST. Used for the "+" next
// to PROJECTS (create) and for "Edit details" in a project's "..." menu,
// wherever that menu appears (its sidebar row, its own page header).
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { AlertCircle, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { api, GENERIC_ERROR } from "@/lib/api"
import type { Project } from "@/lib/api"

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--muted)]"
// Same caps as the server (projects.py).
const DESCRIPTION_MAX = 500
const INSTRUCTIONS_MAX = 600

type Props = {
  open: boolean
  // Present = edit this project. Absent/null = create a new one.
  project?: Project | null
  onSaved: (project: Project) => void
  onCancel: () => void
}

export function ProjectFormDialog({ open, project = null, onSaved, onCancel }: Props) {
  const isEdit = project !== null

  const [name, setName] = useState("")
  const [type, setType] = useState("")
  const [description, setDescription] = useState("")
  const [instructions, setInstructions] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset to the right starting values every time the dialog opens — the
  // project's current fields in edit mode, blank in create mode.
  useEffect(() => {
    if (!open) return
    setName(project?.name ?? "")
    setType(project?.type ?? "")
    setDescription(project?.description ?? "")
    setInstructions(project?.instructions ?? "")
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  async function handleSubmit() {
    setBusy(true)
    setError(null)
    const payload = {
      name: name.trim() || "New project",
      type: type.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
    }
    try {
      const saved = isEdit ? await api.updateProject(project.id, payload) : await api.createProject(payload)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] px-6"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-form-title"
        className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="project-form-title" className="font-heading text-lg font-medium tracking-tight">
          {isEdit ? "Edit project" : "New project"}
        </h2>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Name</span>
              <input
                autoFocus
                className={`${FIELD} ${FOCUS_RING}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Linear Algebra"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Type</span>
              <input
                className={`${FIELD} ${FOCUS_RING}`}
                value={type}
                onChange={(e) => setType(e.target.value)}
                placeholder="Course, research, reading group…"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Description</span>
            <textarea
              className={`thin-scrollbar resize-none ${FIELD} ${FOCUS_RING}`}
              rows={2}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this project is about."
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Instructions</span>
            <textarea
              className={`thin-scrollbar resize-none ${FIELD} ${FOCUS_RING}`}
              rows={3}
              maxLength={INSTRUCTIONS_MAX}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="eg. cite the textbook chapter, use British spelling."
            />
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

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : isEdit ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
