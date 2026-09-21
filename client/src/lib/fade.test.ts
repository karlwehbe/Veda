import { describe, expect, it } from "vitest"

import { FADE_PX, fadeMask, scrollFadeState } from "./fade"

describe("scrollFadeState", () => {
  it("has no fade when everything fits", () => {
    expect(scrollFadeState(0, 200, 200)).toEqual({ top: false, bottom: false })
    expect(scrollFadeState(0, 120, 200)).toEqual({ top: false, bottom: false })
  })

  it("fades only the bottom at the top of overflowing content", () => {
    expect(scrollFadeState(0, 500, 200)).toEqual({ top: false, bottom: true })
  })

  it("fades both edges in the middle", () => {
    expect(scrollFadeState(150, 500, 200)).toEqual({ top: true, bottom: true })
  })

  it("fades only the top once scrolled to the bottom", () => {
    expect(scrollFadeState(300, 500, 200)).toEqual({ top: true, bottom: false })
  })

  it("ignores sub-pixel remainders from fractional scroll positions", () => {
    // 0.4px short of the bottom is the bottom, as far as anyone can see.
    expect(scrollFadeState(299.6, 500, 200)).toEqual({ top: true, bottom: false })
    // ...and 0.4px scrolled is still the top.
    expect(scrollFadeState(0.4, 500, 200)).toEqual({ top: false, bottom: true })
  })

  it("does not fade content that overflows by a sub-pixel amount", () => {
    expect(scrollFadeState(0, 200.6, 200)).toEqual({ top: false, bottom: false })
  })
})

describe("fadeMask", () => {
  it("is no style at all when nothing is hidden", () => {
    expect(fadeMask({ top: false, bottom: false })).toBeUndefined()
  })

  it("fades the bottom edge only", () => {
    const { maskImage } = fadeMask({ top: false, bottom: true })!
    expect(maskImage).toBe(
      `linear-gradient(to bottom, #000 0px, #000 calc(100% - ${FADE_PX}px), transparent 100%)`,
    )
  })

  it("fades the top edge only", () => {
    const { maskImage } = fadeMask({ top: true, bottom: false })!
    expect(maskImage).toBe(`linear-gradient(to bottom, transparent 0px, #000 ${FADE_PX}px, #000 100%)`)
  })

  it("fades both edges", () => {
    const { maskImage } = fadeMask({ top: true, bottom: true })!
    expect(maskImage).toBe(
      `linear-gradient(to bottom, transparent 0px, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), transparent 100%)`,
    )
  })

  it("sets the WebKit-prefixed property too, for Safari", () => {
    const style = fadeMask({ top: false, bottom: true })!
    expect(style.WebkitMaskImage).toBe(style.maskImage)
  })
})
