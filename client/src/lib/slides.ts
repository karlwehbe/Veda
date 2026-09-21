// Pure helpers for the slides feature — kept out of the components so they can
// be unit tested without a DOM.
import { apiUrl } from "@/lib/api"

// The server injects each slide into the notes as ![alt](/slides/{id}/image).
const SLIDE_SRC = /^\/slides\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/image$/i

/** The slide id if `src` is one of our injected slide images, else null. */
export function slideIdFromSrc(src: string | undefined): string | null {
  return src?.match(SLIDE_SRC)?.[1] ?? null
}

/** Slide images are served by the API, not the page's own origin — point the
 *  relative src at it. Any other image src is returned untouched. */
export function resolveSlideSrc(src: string): string {
  return SLIDE_SRC.test(src) ? `${apiUrl}${src}` : src
}

/**
 * The selection after clicking the tile at `index`.
 *
 * A plain click toggles that tile. With shift held (and an earlier click to
 * anchor from), every tile between the two is set to whatever the clicked tile
 * is becoming, the way file lists behave.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  index: number,
  lastIndex: number | null,
  shift: boolean,
): Set<string> {
  const next = new Set(selected)
  const target = ids[index]
  if (target === undefined) return next
  const on = !selected.has(target)
  const [from, to] =
    shift && lastIndex !== null ? [Math.min(lastIndex, index), Math.max(lastIndex, index)] : [index, index]
  for (let i = from; i <= to; i++) {
    const id = ids[i]
    if (id === undefined) continue
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/** "1 slide" / "3 slides". */
export function slideCountLabel(count: number): string {
  return `${count} ${count === 1 ? "slide" : "slides"}`
}
