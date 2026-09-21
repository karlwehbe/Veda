import { describe, expect, it } from "vitest"

import { apiUrl } from "@/lib/api"
import { resolveSlideSrc, slideCountLabel, slideIdFromSrc, toggleSelection } from "./slides"

const ID = "3f2b8c1e-9a4d-4e7b-8c55-0d1e2f3a4b5c"
const IDS = ["a", "b", "c", "d", "e"]

describe("slideIdFromSrc", () => {
  it("extracts the id from an injected slide image", () => {
    expect(slideIdFromSrc(`/slides/${ID}/image`)).toBe(ID)
  })

  it("ignores every other image", () => {
    expect(slideIdFromSrc("https://example.com/a.png")).toBeNull()
    expect(slideIdFromSrc(`/slides/${ID}/thumbnail`)).toBeNull()
    expect(slideIdFromSrc("/slides/not-a-uuid/image")).toBeNull()
    expect(slideIdFromSrc(undefined)).toBeNull()
  })

  it("does not match a slide path embedded in a longer URL", () => {
    expect(slideIdFromSrc(`https://evil.example/slides/${ID}/image`)).toBeNull()
  })
})

describe("resolveSlideSrc", () => {
  it("points slide images at the API", () => {
    expect(resolveSlideSrc(`/slides/${ID}/image`)).toBe(`${apiUrl}/slides/${ID}/image`)
  })

  it("leaves other sources alone", () => {
    expect(resolveSlideSrc("https://example.com/a.png")).toBe("https://example.com/a.png")
    expect(resolveSlideSrc("/other/path.png")).toBe("/other/path.png")
  })
})

describe("toggleSelection", () => {
  it("toggles one tile on a plain click", () => {
    const on = toggleSelection(new Set(), IDS, 1, null, false)
    expect([...on]).toEqual(["b"])
    expect(toggleSelection(on, IDS, 1, 1, false).size).toBe(0)
  })

  it("does not mutate the previous selection", () => {
    const before = new Set(["a"])
    toggleSelection(before, IDS, 2, 0, false)
    expect([...before]).toEqual(["a"])
  })

  it("selects the whole range on shift-click", () => {
    const next = toggleSelection(new Set(["a"]), IDS, 3, 0, true)
    expect([...next].sort()).toEqual(["a", "b", "c", "d"])
  })

  it("selects a range backwards too", () => {
    const next = toggleSelection(new Set(), IDS, 1, 3, true)
    expect([...next].sort()).toEqual(["b", "c", "d"])
  })

  it("deselects the range when the clicked tile is being turned off", () => {
    const all = new Set(IDS)
    const next = toggleSelection(all, IDS, 3, 1, true)
    expect([...next].sort()).toEqual(["a", "e"])
  })

  it("treats shift-click with no anchor as a plain click", () => {
    expect([...toggleSelection(new Set(), IDS, 2, null, true)]).toEqual(["c"])
  })

  it("ignores an out-of-range index", () => {
    expect(toggleSelection(new Set(["a"]), IDS, 9, null, false).size).toBe(1)
  })
})

describe("slideCountLabel", () => {
  it("pluralises", () => {
    expect(slideCountLabel(1)).toBe("1 slide")
    expect(slideCountLabel(0)).toBe("0 slides")
    expect(slideCountLabel(12)).toBe("12 slides")
  })
})
