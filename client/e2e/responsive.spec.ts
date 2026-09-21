// Acceptance: under 768px the sidebar and notes are drawers laid over the chat,
// not columns beside it; at 768px and up the side-by-side layout is unchanged.
// Backed by the stubbed stack, like the other specs.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"

const API = process.env.VITE_API_URL ?? "http://localhost:8001"
const COMPOSER = "Type or record…"
const PHONE = { width: 390, height: 800 }

const created: string[] = []

test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`${API}/conversations/${id}`)
})

/** A conversation that already has notes (the stub writes them on any message). */
async function conversationWithNotes(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/conversations`)
  const { id } = (await res.json()) as { id: string }
  created.push(id)
  const sent = await request.post(`${API}/conversations/${id}/messages`, { multipart: { transcript: "vectors" } })
  expect(sent.ok()).toBe(true)
  return id
}

async function emptyConversation(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/conversations`)
  const { id } = (await res.json()) as { id: string }
  created.push(id)
  return id
}

const sidebar = (page: Page) => page.locator("aside[aria-label='Sidebar']")
const notes = (page: Page) => page.locator("aside[aria-label='Notes']")
// The column that holds the page (the chat), beside the sidebar on desktop.
const chatColumn = (page: Page) => page.locator("div.min-w-0.flex-1.overflow-hidden").first()
// The chat itself, without the notes panel beside it.
const chat = (page: Page) => page.getByTestId("chat-column")

const box = async (loc: Locator) => (await loc.boundingBox())!
const isInert = (loc: Locator) => loc.evaluate((el) => el.hasAttribute("inert"))

test.describe("Small screens (under 768px)", () => {
  test.use({ viewport: PHONE })

  test("the chat gets the whole width, and both panels start closed and off-screen", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.goto(`/c/${id}`)
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible()

    expect((await box(chatColumn(page))).width).toBeCloseTo(PHONE.width, 0)

    const s = await box(sidebar(page))
    expect(s.x + s.width).toBeLessThanOrEqual(1) // fully off the left edge
    expect(await isInert(sidebar(page))).toBe(true)

    const n = await box(notes(page))
    expect(n.x).toBeGreaterThanOrEqual(PHONE.width - 1) // fully off the right edge
    expect(await isInert(notes(page))).toBe(true)

    // No sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test("the sidebar opens over the chat without squeezing it, and closes three ways", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.goto(`/c/${id}`)
    const before = (await box(chatColumn(page))).width

    await page.getByRole("button", { name: "Open sidebar" }).click()
    const drawer = page.getByRole("dialog", { name: "Sidebar" })
    await expect(drawer).toBeVisible()
    await expect.poll(async () => (await box(drawer)).x).toBeCloseTo(0, 0)
    expect((await box(drawer)).width).toBeLessThanOrEqual(PHONE.width * 0.85 + 1)
    // Overlaid, not pushed: the chat is exactly as wide as before.
    expect((await box(chatColumn(page))).width).toBe(before)

    // 1. Backdrop.
    await page.mouse.click(PHONE.width - 5, 400)
    await expect(drawer).toHaveCount(0)
    expect(await isInert(sidebar(page))).toBe(true)

    // 2. Escape.
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)

    // 3. Its own close button.
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await page.getByRole("button", { name: "Close sidebar" }).click()
    await expect(drawer).toHaveCount(0)
  })

  test("choosing a conversation closes the drawer and goes there; New chat closes it even on the same page", async ({
    page,
    request,
  }) => {
    const id = await conversationWithNotes(request)
    await page.goto(`/c/${id}`)

    await page.getByRole("button", { name: "Open sidebar" }).click()
    const drawer = page.getByRole("dialog", { name: "Sidebar" })
    await drawer.getByRole("link", { name: "New chat" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(drawer).toHaveCount(0)

    // Already on "/": the route doesn't change, but the drawer must still close.
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole("link", { name: "New chat" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(drawer).toHaveCount(0)
  })

  test("the notes open from the right over the chat, and close three ways", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.goto(`/c/${id}`)
    const before = (await box(chatColumn(page))).width

    await page.getByRole("button", { name: "Open notes" }).click()
    const drawer = page.getByRole("dialog", { name: "Notes" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("heading", { name: "Vectors" })).toBeVisible()
    await expect.poll(async () => (await box(drawer)).x + (await box(drawer)).width).toBeCloseTo(PHONE.width, 0)
    expect((await box(drawer)).width).toBeLessThanOrEqual(PHONE.width * 0.92 + 1)
    expect((await box(chatColumn(page))).width).toBe(before)

    // 1. Close button.
    await drawer.getByRole("button", { name: "Close notes" }).click()
    await expect(drawer).toHaveCount(0)

    // 2. Backdrop.
    await page.getByRole("button", { name: "Open notes" }).click()
    await expect(drawer).toBeVisible()
    await page.mouse.click(5, 400)
    await expect(drawer).toHaveCount(0)

    // 3. Escape.
    await page.getByRole("button", { name: "Open notes" }).click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
  })

  test("the notes never open by themselves when they are created", async ({ page }) => {
    await page.goto("/")
    await page.getByPlaceholder(COMPOSER).fill("a vector has magnitude and direction")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/, { timeout: 30_000 })
    const id = page.url().match(/\/c\/([0-9a-f-]{36})/)![1]!
    created.push(id)

    // Notes exist now (the button appears)...
    await expect(page.getByRole("button", { name: "Open notes" })).toBeVisible()
    // ...but the drawer stayed closed.
    await expect(page.getByRole("dialog", { name: "Notes" })).toHaveCount(0)
    expect(await isInert(notes(page))).toBe(true)
  })

  test("there is no notes button until there are notes", async ({ page, request }) => {
    const id = await emptyConversation(request)
    await page.goto(`/c/${id}`)
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open notes" })).toHaveCount(0)
  })

  test("only one drawer is open at a time", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.goto(`/c/${id}`)

    await page.getByRole("button", { name: "Open notes" }).click()
    await expect(page.getByRole("dialog", { name: "Notes" })).toBeVisible()
    // The backdrop covers the header, so trigger the other button directly.
    await page.getByRole("button", { name: "Open sidebar" }).dispatchEvent("click")

    await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Notes" })).toHaveCount(0)
  })

  test("the new-chat page has the menu button too, and the project page", async ({ page, request }) => {
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible()
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible()

    const project = await request.post(`${API}/projects`, {
      data: { name: "Responsive check", type: "", description: "", instructions: "" },
    })
    const { id } = (await project.json()) as { id: string }
    try {
      await page.goto(`/p/${id}`)
      await expect(page.getByRole("heading", { name: "Responsive check" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible()
    } finally {
      await request.delete(`${API}/projects/${id}`)
    }
  })

  for (const width of [320, 360, 390]) {
    test(`the composer is usable at ${width}px wide`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 })
      await page.goto("/")
      const input = page.getByPlaceholder(COMPOSER)
      await expect(input).toBeVisible()

      // Everything fits on one row: add, record, send are all on screen.
      for (const name of ["Add files", "Choose recording source", "Send"]) {
        const b = await box(page.getByRole("button", { name }))
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width).toBeLessThanOrEqual(width)
      }
      expect((await box(input)).height).toBeLessThan(48)

      // And the placeholder is readable, not squeezed down to a letter.
      const fits = await input.evaluate((el) => {
        const probe = document.createElement("span")
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(el).font}`
        probe.textContent = (el as HTMLTextAreaElement).placeholder
        document.body.appendChild(probe)
        const w = probe.getBoundingClientRect().width
        probe.remove()
        return w <= el.clientWidth
      })
      expect(fits).toBe(true)
    })
  }
})

test.describe("The breakpoint", () => {
  test("at 768px with notes, the notes sit beside the chat and the sidebar gives way to a drawer", async ({
    page,
    request,
  }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto(`/c/${id}`)

    // The notes are docked (not a drawer, no notes button)...
    await expect(page.getByRole("complementary", { name: "Notes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open notes" })).toHaveCount(0)
    // ...and the sidebar has stepped aside so the chat keeps its width.
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible()
    expect((await box(chat(page))).width).toBeGreaterThanOrEqual(359)
  })

  test("at 768px with no notes, the sidebar stays docked beside the chat as before", async ({ page, request }) => {
    const id = await emptyConversation(request)
    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto(`/c/${id}`)

    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open notes" })).toHaveCount(0)
    const s = await box(page.locator("aside").first())
    expect(s.x).toBe(0)
    expect(s.width).toBe(256)
    expect(await isInert(page.locator("aside").first())).toBe(false)
    expect((await box(chat(page))).width).toBe(768 - 256)
  })

  test("at 767px it switches to drawers", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 767, height: 800 })
    await page.goto(`/c/${id}`)
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open notes" })).toBeVisible()
    expect((await box(chatColumn(page))).width).toBeCloseTo(767, 0)
  })

  test("resizing up to desktop closes an open drawer and restores the side-by-side layout", async ({
    page,
    request,
  }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize(PHONE)
    await page.goto(`/c/${id}`)
    await page.getByRole("button", { name: "Open notes" }).click()
    await expect(page.getByRole("dialog", { name: "Notes" })).toBeVisible()

    await page.setViewportSize({ width: 1200, height: 800 })
    // Desktop: notes are a normal panel again, the sidebar a real column. Polled,
    // not read once: the layout follows the resize a frame later, and a closed
    // notes drawer already counts as a visible "complementary" landmark, so
    // waiting for that alone can pass a moment too early.
    await expect(page.getByRole("dialog", { name: "Notes" })).toHaveCount(0)
    await expect.poll(async () => (await box(page.locator("aside").first())).width).toBe(256)
    await expect.poll(async () => (await box(page.getByRole("complementary", { name: "Notes" }))).x).toBeLessThan(1200 - 300)

    // Back to a phone: the stale "open" did not come back.
    await page.setViewportSize(PHONE)
    await expect(page.getByRole("dialog", { name: "Notes" })).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0)
    expect(await isInert(notes(page))).toBe(true)
  })
})

// Above the drawer breakpoint the chat is never allowed to get narrower than
// 360px: the notes shrink first, and only when they can't shrink further does the
// sidebar become a drawer. (The arithmetic is unit-tested in layout-math.test.ts;
// this checks the real page does what the arithmetic says.)
test.describe("Adaptive layout (768px and up)", () => {
  const MIN_CHAT = 360
  // Independent of layout-math.ts on purpose: the expectation spelled out by hand.
  const sidebarDockedAt = (w: number) => w - 256 - MIN_CHAT >= 320
  const notesWidthAt = (w: number) => (sidebarDockedAt(w) ? Math.min(420, w - 256 - MIN_CHAT) : Math.min(420, w - MIN_CHAT))

  async function settle(page: Page, width: number) {
    await page.setViewportSize({ width, height: 800 })
    // The layout follows the resize on the next animation frame.
    await expect
      .poll(async () => (await box(chat(page))).width, { message: `chat width at ${width}px` })
      .toBeGreaterThanOrEqual(MIN_CHAT - 1)
  }

  test("the chat never gets narrower than 360px, sweeping the width down and back up", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 1600, height: 800 })
    await page.goto(`/c/${id}`)
    await expect(page.getByRole("complementary", { name: "Notes" })).toBeVisible()

    const down = [1600, 1440, 1200, 1100, 1036, 1000, 936, 935, 900, 850, 800, 768]
    for (const width of [...down, ...[...down].reverse()]) {
      await settle(page, width)
      const label = `at ${width}px`

      // Never a squeeze, never a sideways scroll.
      expect((await box(chat(page))).width, label).toBeGreaterThanOrEqual(MIN_CHAT - 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label).toBe(true)

      // The sidebar is docked or a drawer exactly as the rule says...
      const docked = sidebarDockedAt(width)
      await expect(page.getByRole("button", { name: "Open sidebar" }), label).toHaveCount(docked ? 0 : 1)
      // ...the notes always stay beside the chat, at the width the rule says.
      const notesBox = await box(page.getByRole("complementary", { name: "Notes" }))
      expect(notesBox.width, label).toBeGreaterThanOrEqual(319)
      expect(Math.abs(notesBox.width - notesWidthAt(width)), label).toBeLessThanOrEqual(1)
    }
  })

  test("the sidebar drawer works in the mid band, and the chat is not squeezed by opening it", async ({
    page,
    request,
  }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 850, height: 800 })
    await page.goto(`/c/${id}`)
    const before = (await box(chat(page))).width

    await page.getByRole("button", { name: "Open sidebar" }).click()
    const drawer = page.getByRole("dialog", { name: "Sidebar" })
    await expect(drawer).toBeVisible()
    expect((await box(chat(page))).width).toBe(before) // overlaid, not pushed

    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)

    await page.getByRole("button", { name: "Open sidebar" }).click()
    await drawer.getByRole("link", { name: "New chat" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(drawer).toHaveCount(0)
  })

  test("growing the window past the threshold docks the sidebar and closes the drawer", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 800, height: 800 })
    await page.goto(`/c/${id}`)
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible()

    await settle(page, 1100)
    await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0)
    expect((await box(page.locator("aside").first())).width).toBe(256)

    // Shrinking again does not bring the stale drawer back open.
    await settle(page, 800)
    await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0)
  })

  test("dragging the notes wide stops where the chat would drop below its minimum, and the preference survives", async ({
    page,
    request,
  }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.goto(`/c/${id}`)
    const panel = page.getByRole("complementary", { name: "Notes" })
    await expect(panel).toBeVisible()

    // Drag the notes' left edge as far left as it will go.
    const handle = await box(panel.locator("div.cursor-col-resize"))
    const y = handle.y + handle.height / 2
    await page.mouse.move(handle.x + handle.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(60, y, { steps: 12 })
    await page.mouse.up()

    // 1200 - 256 (sidebar) - 360 (chat's minimum) = 584. Not one pixel wider.
    await expect.poll(async () => Math.round((await box(panel)).width)).toBe(584)
    expect((await box(chat(page))).width).toBeGreaterThanOrEqual(MIN_CHAT - 1)
    expect((await box(page.locator("aside").first())).width).toBe(256) // the sidebar stayed put
    expect(await page.evaluate(() => localStorage.getItem("notes-panel-width"))).toBe("584")

    // A smaller window squeezes the notes to fit...
    await settle(page, 900)
    expect(Math.round((await box(panel)).width)).toBe(900 - MIN_CHAT) // sidebar is a drawer: 540
    expect((await box(chat(page))).width).toBeGreaterThanOrEqual(MIN_CHAT - 1)

    // ...without forgetting what was chosen: the width comes back on a big window.
    await settle(page, 1200)
    await expect.poll(async () => Math.round((await box(panel)).width)).toBe(584)
  })

  test("a collapsed sidebar rail is honoured, and leaves room to keep it docked", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.addInitScript(() => localStorage.setItem("sidebar-collapsed", "true"))
    await page.setViewportSize({ width: 800, height: 800 })
    await page.goto(`/c/${id}`)

    // 800 - 56 (rail) - 360 = 384 >= 320: stays docked, where a full sidebar could not.
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0)
    expect((await box(page.locator("aside").first())).width).toBe(56)
    expect(Math.round((await box(page.getByRole("complementary", { name: "Notes" }))).width)).toBe(384)
    expect((await box(chat(page))).width).toBeGreaterThanOrEqual(MIN_CHAT - 1)
  })

  test("a collapsed notes rail leaves everything docked at 768px", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.addInitScript(() => localStorage.setItem("notes-panel-collapsed", "true"))
    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto(`/c/${id}`)

    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0)
    expect(Math.round((await box(page.getByRole("complementary", { name: "Notes" }))).width)).toBe(48)
    expect(Math.round((await box(chat(page))).width)).toBe(768 - 256 - 48)
  })

  test("the notes panel still collapses and expands, and remembers it", async ({ page, request }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.goto(`/c/${id}`)
    await page.getByRole("button", { name: "Collapse notes" }).click()
    await expect.poll(async () => Math.round((await box(page.getByRole("complementary", { name: "Notes" }))).width)).toBe(48)

    await page.reload()
    await expect(page.getByRole("button", { name: "Expand notes" })).toBeVisible()
    await page.getByRole("button", { name: "Expand notes" }).click()
    await expect.poll(async () => Math.round((await box(page.getByRole("complementary", { name: "Notes" }))).width)).toBe(420)
  })

  test("the notes have no fixed maximum width: they can grow until the chat reaches its minimum", async ({
    page,
    request,
  }) => {
    const id = await conversationWithNotes(request)
    await page.setViewportSize({ width: 1800, height: 800 })
    await page.goto(`/c/${id}`)
    const panel = page.getByRole("complementary", { name: "Notes" })
    await expect(panel).toBeVisible()

    const handle = await box(panel.locator("div.cursor-col-resize"))
    const y = handle.y + handle.height / 2
    await page.mouse.move(handle.x + handle.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(40, y, { steps: 15 })
    await page.mouse.up()

    // 1800 - 256 (sidebar) - 360 (the chat's minimum) = 1184: far past the old 720 cap.
    await expect.poll(async () => Math.round((await box(panel)).width)).toBe(1184)
    expect((await box(chat(page))).width).toBeGreaterThanOrEqual(MIN_CHAT - 1)
  })
})

