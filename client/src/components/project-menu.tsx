// The "..." action menu on a project — same two actions (Edit details,
// Delete project) wherever a project can be acted on: its sidebar row and
// its own page header. Portaled to document.body, fixed-positioned off the
// trigger's own rect, so it isn't clipped by the sidebar's overflow-y-auto
// scroll container or the page's layout.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MoreHorizontal } from "lucide-react"
import type { LucideIcon } from "lucide-react"

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

export type ProjectMenuItem = {
  label: string
  icon: LucideIcon
  onSelect: () => void
  destructive?: boolean
}

type Props = {
  items: ProjectMenuItem[]
  ariaLabel: string
  className?: string
  iconClassName?: string
}

export function ProjectMenu({ items, ariaLabel, className, iconClassName }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const el = buttonRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Right edge of the menu lines up with the trigger's right edge,
    // opening downward — same corner a "..." menu opens from everywhere else.
    setPos({ top: rect.bottom + 4, left: rect.right })
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        onClick={toggle}
        className={className ?? `rounded p-1 text-[var(--muted)] hover:text-foreground ${FOCUS_RING}`}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className={iconClassName ?? "size-3"} />
      </button>
      {/* Same visual language as the chat composer's recording-source menu —
          fixed-positioned portal, rounded-xl card, per-item icon + label. */}
      {open
        ? createPortal(
            <div
              style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-100%)" }}
              className="z-50 pt-1"
            >
              <div
                ref={menuRef}
                role="menu"
                className="flex min-w-40 flex-col gap-1.5 rounded-xl border border-border bg-background p-1 shadow-md"
              >
                {items.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setOpen(false)
                      item.onSelect()
                    }}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap hover:bg-[var(--hover)] ${FOCUS_RING} ${
                      item.destructive ? "text-[var(--error)]" : "text-foreground"
                    }`}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
