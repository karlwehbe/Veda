// A soft fade where text is clipped, instead of a hard straight cutoff.
//
// Done with a CSS mask on the clipping element rather than an overlay gradient:
// a mask needs no knowledge of the background colour, so the same code works in
// light and dark themes, over the dark message bubble and the light composer
// alike. Applied to an element's *content* (an inner wrapper, for the bubble),
// the surrounding box — its background and rounded edge — is left intact and
// only the text fades.
import { useCallback, useEffect, useLayoutEffect, useState } from "react"
import type { CSSProperties } from "react"

/** How tall the fade is. */
export const FADE_PX = 40

export type FadeEdges = { top: boolean; bottom: boolean }

const NO_FADE: FadeEdges = { top: false, bottom: false }

/**
 * Which edges of a scrolling box have content hidden past them. `> 1` rather
 * than `> 0`: scroll positions are fractional on zoomed or high-DPI screens,
 * and a sub-pixel remainder must not leave a fade over text that is fully
 * visible.
 */
export function scrollFadeState(scrollTop: number, scrollHeight: number, clientHeight: number): FadeEdges {
  const hidden = scrollHeight - clientHeight
  if (hidden <= 1) return NO_FADE
  return { top: scrollTop > 1, bottom: scrollTop < hidden - 1 }
}

/** The mask style for the given edges, or undefined when nothing is hidden —
 *  no mask at all rather than an invisible one. */
export function fadeMask({ top, bottom }: FadeEdges): CSSProperties | undefined {
  if (!top && !bottom) return undefined
  const stops = [
    top ? `transparent 0px, #000 ${FADE_PX}px` : "#000 0px",
    bottom ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : "#000 100%",
  ].join(", ")
  const gradient = `linear-gradient(to bottom, ${stops})`
  return { maskImage: gradient, WebkitMaskImage: gradient }
}

/**
 * Tracks which edges of a *scrolling* element currently have hidden content,
 * for use with fadeMask. Returns a callback ref to put on the element (a
 * callback, not an object ref, so the hook notices when the element mounts or
 * is swapped for another — the composer swaps its textarea for a status
 * display) and the current edges.
 */
export function useScrollFade<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [edges, setEdges] = useState<FadeEdges>(NO_FADE)

  const update = useCallback(() => {
    const next = el ? scrollFadeState(el.scrollTop, el.scrollHeight, el.clientHeight) : NO_FADE
    // Bail out with the previous object when nothing changed, so measuring on
    // every render doesn't cause a render loop.
    setEdges((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next))
  }, [el])

  // After every render: typing or a growing transcript changes scrollHeight
  // without changing the element's box, so neither event below would fire.
  useLayoutEffect(update)

  useEffect(() => {
    if (!el) return
    el.addEventListener("scroll", update, { passive: true })
    // The element's own box, plus its children's: a scroller whose box is fixed
    // (the chat thread) changes what is hidden when its *content* grows, which
    // only shows up as a size change on the child.
    const observer = new ResizeObserver(update)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => {
      el.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [el, update])

  return { ref: setEl, edges }
}
