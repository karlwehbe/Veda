// Selectable thumbnail grid, shared by the upload picker and the manage-slides
// dialog. Each tile is a checkbox; shift-click selects a range.
import { useRef } from "react"
import { Check } from "lucide-react"

import { toggleSelection } from "@/lib/slides"

export type SlideGridItem = {
  id: string
  src: string
  /** Shown under the thumbnail, e.g. "Page 4". */
  label: string
  alt: string
}

export function SlideGrid({
  items,
  selected,
  onChange,
  disabled = false,
  dimUnselected = true,
}: {
  items: SlideGridItem[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  disabled?: boolean
  /** Fade tiles that aren't selected. Right when unselected means "left out"
   *  (the picker); wrong when selecting means "act on these" (manage). */
  dimUnselected?: boolean
}) {
  // The tile last clicked, the anchor for a shift-click range. A ref: it never
  // needs to trigger a render.
  const lastIndexRef = useRef<number | null>(null)
  const ids = items.map((item) => item.id)

  return (
    <div
      role="group"
      aria-label="Slides"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
    >
      {items.map((item, index) => {
        const isSelected = selected.has(item.id)
        return (
          <button
            key={item.id}
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={`${item.label}: ${item.alt}`}
            disabled={disabled}
            onClick={(e) => {
              onChange(toggleSelection(selected, ids, index, lastIndexRef.current, e.shiftKey))
              lastIndexRef.current = index
            }}
            className={`group relative flex flex-col gap-1.5 rounded-lg border p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 ${
              isSelected
                ? "border-foreground bg-[var(--hover)]"
                : "border-border hover:bg-[var(--hover)]"
            }`}
          >
            <span className="relative block overflow-hidden rounded-md bg-muted">
              <img
                src={item.src}
                alt=""
                loading="lazy"
                draggable={false}
                className={`block aspect-[4/3] w-full object-contain transition-opacity ${
                  isSelected || !dimUnselected ? "" : "opacity-50"
                }`}
              />
              <span
                aria-hidden
                className={`absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full border text-background ${
                  isSelected ? "border-foreground bg-foreground" : "border-border bg-background/80"
                }`}
              >
                {isSelected ? <Check className="size-3" /> : null}
              </span>
            </span>
            <span className="truncate px-0.5 text-xs text-[var(--muted)]">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
