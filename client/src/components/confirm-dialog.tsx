// Small reusable confirmation modal — centered, portaled to document.body so
// it renders above everything (sidebar, notes panel) regardless of any
// ancestor's overflow/stacking context. Closes on Escape or backdrop click.
import { useEffect } from "react"
import { X } from "lucide-react"
import { createPortal } from "react-dom"

import { Button } from "@/components/ui/button"

type Props = {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] px-6"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="confirm-dialog-title" className="font-heading text-lg font-medium tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="-m-1 shrink-0 rounded-full p-1 text-[var(--muted)] outline-none hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1.5 text-sm text-[var(--muted)]">{description}</p>
        <div className="mt-5 flex justify-end gap-2">
          {/* Cancel is only offered when confirming will delete something; every dialog still has the X. */}
          {destructive ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={onConfirm}
            className={destructive ? "bg-[var(--error)] text-white hover:bg-[var(--error)]/90" : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
