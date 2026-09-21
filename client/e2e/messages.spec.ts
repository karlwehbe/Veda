// Acceptance: long messages collapse behind "Show more", and text that is
// clipped fades out instead of being sliced off at a hard edge. Backed by the
// stubbed stack, like the other specs.
import { expect, test, type Locator, type Page } from "@playwright/test"

const COMPOSER = "Type or record…"
const API = process.env.VITE_API_URL ?? "http://localhost:8001"
// The collapsed cap: 15rem.
const COLLAPSED_MAX = 240

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${String(i + 1).padStart(2, "0")} of a very long lecture message`).join("\n")

test.afterEach(async ({ page, request }) => {
  const match = page.url().match(/\/c\/([0-9a-f-]{36})/)
  if (match) await request.delete(`${API}/conversations/${match[1]}`)
})

async function send(page: Page, text: string) {
  await page.goto("/")
  await page.getByPlaceholder(COMPOSER).fill(text)
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/, { timeout: 30_000 })
}

// NaN while the element has no box (mid re-render, e.g. the pending message being
// swapped for the saved one): NaN fails every comparison, so a polling assertion
// simply retries instead of throwing.
const height = async (loc: Locator) => (await loc.boundingBox())?.height ?? NaN
const mask = (loc: Locator) =>
  loc.evaluate((el) => {
    const s = getComputedStyle(el)
    return s.maskImage || s.webkitMaskImage || "none"
  })

test.describe("Long messages", () => {
  test("a short message is left alone", async ({ page }) => {
    await send(page, "a short message")
    const text = page.getByText("a short message", { exact: true })
    await expect(text).toBeVisible()
    await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0)
    await expect.poll(() => mask(text)).toBe("none")
  })

  test("a long message collapses with a fade, and Show more / Show less toggles it", async ({ page }) => {
    await send(page, LONG)
    const text = page.getByText("Line 01 of a very long lecture message")

    // Collapsed: capped, faded, with a button.
    await expect(page.getByRole("button", { name: "Show more" })).toBeVisible()
    await expect.poll(() => height(text)).toBeLessThanOrEqual(COLLAPSED_MAX + 1)
    await expect.poll(() => mask(text)).not.toBe("none")

    // Expanded: everything, no fade.
    await page.getByRole("button", { name: "Show more" }).click()
    await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true")
    await expect.poll(() => height(text)).toBeGreaterThan(COLLAPSED_MAX * 2)
    await expect.poll(() => mask(text)).toBe("none")

    // And back.
    await page.getByRole("button", { name: "Show less" }).click()
    await expect(page.getByRole("button", { name: "Show more" })).toBeVisible()
    await expect.poll(() => height(text)).toBeLessThanOrEqual(COLLAPSED_MAX + 1)
  })

  test("the bubble keeps its own rounded background; only the text is masked", async ({ page }) => {
    await send(page, LONG)
    const text = page.getByText("Line 01 of a very long lecture message")
    const bubble = text.locator("xpath=..")
    await expect.poll(() => mask(bubble)).toBe("none")
    expect(await bubble.evaluate((el) => getComputedStyle(el).borderRadius)).not.toBe("0px")
  })

  test("a long transcript of an uploaded audio file collapses the same way", async ({ page, request }) => {
    // A message with a filename (other than recording.webm) renders as a file
    // chip that reveals its transcript. Deepgram itself isn't stubbed, so seed
    // one through the transcript + filename path.
    const created = await request.post(`${API}/conversations`)
    const { id } = (await created.json()) as { id: string }
    const sent = await request.post(`${API}/conversations/${id}/messages`, {
      multipart: { transcript: LONG, filename: "lecture.mp3" },
    })
    expect(sent.ok()).toBe(true)
    await page.goto(`/c/${id}`)

    await page.getByRole("button", { name: "Show transcript" }).click()
    const text = page.getByText("Line 01 of a very long lecture message")
    await expect(text).toBeVisible()
    await expect.poll(() => height(text)).toBeLessThanOrEqual(COLLAPSED_MAX + 1)
    await expect.poll(() => mask(text)).not.toBe("none")

    await page.getByRole("button", { name: "Show more" }).click()
    await expect.poll(() => height(text)).toBeGreaterThan(COLLAPSED_MAX * 2)
    await expect.poll(() => mask(text)).toBe("none")
  })
})

test.describe("The chat composer", () => {
  test("text that overflows the box fades instead of being cut off", async ({ page }) => {
    await page.goto("/")
    const box = page.getByPlaceholder(COMPOSER)

    // Short text: nothing hidden, no fade.
    await box.fill("hello")
    await expect.poll(() => mask(box)).toBe("none")

    // Long text: capped at 200px, faded. It scrolls to the newest text, so the
    // hidden content is above — a fade at the top edge.
    await box.fill(LONG)
    await expect.poll(() => height(box)).toBeLessThanOrEqual(201)
    await expect.poll(() => mask(box)).not.toBe("none")
    const atBottom = await mask(box)

    // Halfway: content hidden on both sides, so the mask is different again.
    await box.evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
    })
    await expect.poll(() => mask(box)).not.toBe(atBottom)
    const middle = await mask(box)
    expect(middle).not.toBe("none")

    // At the top: only the bottom is hidden — different from both.
    await box.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect.poll(() => mask(box)).not.toBe(middle)
    await expect.poll(() => mask(box)).not.toBe("none")
    expect(await mask(box)).not.toBe(atBottom)

    // Clearing it removes the fade.
    await box.fill("")
    await expect.poll(() => mask(box)).toBe("none")
  })
})

test.describe("Chat styling", () => {
  test("the AI's text uses the same font as the titles", async ({ page }) => {
    await send(page, "a short message")
    const reply = page.getByText("Started your notes on vectors.").first()
    await expect(reply).toBeVisible()
    const font = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).fontFamily)
    const title = await font(page.getByRole("heading", { level: 1 }).first())
    expect(title).toContain("Fraunces")
    expect(await font(reply)).toBe(title)
  })

  test("messages have no border", async ({ page, request }) => {
    const created = await request.post(`${API}/conversations`)
    const { id } = (await created.json()) as { id: string }
    await request.post(`${API}/conversations/${id}/messages`, { multipart: { transcript: "typed message" } })
    await request.post(`${API}/conversations/${id}/messages`, {
      multipart: { transcript: "uploaded", filename: "lecture.mp3" },
    })
    await page.goto(`/c/${id}`)
    const width = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).borderTopWidth)
    expect(await width(page.getByText("typed message", { exact: true }).locator("xpath=.."))).toBe("0px")
    expect(await width(page.getByRole("button", { name: "Show transcript" }))).toBe("0px")
  })

  test("the thread fades into the composer while there is more below, not at the newest message", async ({
    page,
    request,
  }) => {
    const created = await request.post(`${API}/conversations`)
    const { id } = (await created.json()) as { id: string }
    for (let i = 1; i <= 9; i++) {
      await request.post(`${API}/conversations/${id}/messages`, { multipart: { transcript: `message number ${i}` } })
    }
    await page.goto(`/c/${id}`)
    await expect(page.getByText("message number 9", { exact: true })).toBeVisible()

    const thread = page.locator("div.overflow-y-auto", { has: page.getByText("message number 9", { exact: true }) }).first()
    // Opens scrolled to the newest message: nothing below, so no fade over it.
    await expect.poll(() => mask(thread)).toBe("none")

    // Scroll up: newer messages are now hidden below, so the seam fades.
    await thread.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect.poll(() => mask(thread)).not.toBe("none")
  })

  test("the AI's text is regular weight, not bold", async ({ page }) => {
    await send(page, "a short message")
    const reply = page.getByText("Started your notes on vectors.").first()
    await expect(reply).toBeVisible()
    expect(await reply.evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBe(400)
  })

  test("message boxes share one grey, a little darker than before", async ({ page, request }) => {
    const created = await request.post(`${API}/conversations`)
    const { id } = (await created.json()) as { id: string }
    await request.post(`${API}/conversations/${id}/messages`, { multipart: { transcript: "typed message" } })
    await request.post(`${API}/conversations/${id}/messages`, {
      multipart: { transcript: "uploaded", filename: "lecture.mp3" },
    })
    await page.goto(`/c/${id}`)
    const bg = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)
    const typed = await bg(page.getByText("typed message", { exact: true }).locator("xpath=.."))
    const file = await bg(page.getByRole("button", { name: "Show transcript" }).locator("xpath=.."))
    expect(typed).toBe("rgb(242, 242, 242)")
    expect(file).toBe(typed)
  })

  test("an uploaded audio file and its transcript are one box, not two", async ({ page, request }) => {
    const created = await request.post(`${API}/conversations`)
    const { id } = (await created.json()) as { id: string }
    await request.post(`${API}/conversations/${id}/messages`, {
      multipart: { transcript: "words from the lecture", filename: "lecture.mp3" },
    })
    await page.goto(`/c/${id}`)

    // Closed: just the file name in a box.
    // Matches both labels: the toggle reads "Hide transcript" once opened.
    const toggle = page.getByRole("button", { name: /(Show|Hide) transcript/ })
    const box = toggle.locator("xpath=..")
    await expect(box).toContainText("lecture.mp3")
    await expect(page.getByText("words from the lecture")).toHaveCount(0)
    const closed = await box.boundingBox()

    // Open: the transcript appears inside that same box, which grows to hold it.
    await toggle.click()
    const text = page.getByText("words from the lecture", { exact: true })
    await expect(text).toBeVisible()
    await expect(box).toContainText("words from the lecture")
    await expect(box).toContainText("lecture.mp3")
    expect((await box.boundingBox())!.height).toBeGreaterThan(closed!.height)
    // The transcript's parent is the file's own box — no second grey box.
    expect(await text.evaluate((el, boxEl) => el.parentElement === boxEl, await box.elementHandle())).toBe(true)
  })

  test("the placeholder stays on one line and overflows when the composer is narrow", async ({ page }) => {
    // The layout now keeps the chat at 360px or more, so the composer is never
    // squeezed this narrow on its own. Force it, to prove the placeholder
    // clips instead of wrapping whenever it does get tight.
    await page.goto("/")
    await page.addStyleTag({ content: ".max-w-3xl { max-width: 190px !important; }" })
    const box = page.getByPlaceholder(COMPOSER)
    await expect(box).toBeVisible()

    // Empty: no wrapping, and the box did not grow a second line.
    expect(await box.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap")
    expect(await height(box)).toBeLessThan(48)
    // The placeholder really is wider than the box (so it is being clipped, not
    // squeezed) — otherwise this test would pass without proving anything.
    const clipped = await box.evaluate((el) => {
      const probe = document.createElement("span")
      const style = getComputedStyle(el)
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font}`
      probe.textContent = (el as HTMLTextAreaElement).placeholder
      document.body.appendChild(probe)
      const textWidth = probe.getBoundingClientRect().width
      probe.remove()
      return textWidth > el.clientWidth
    })
    expect(clipped).toBe(true)

    // Once there is real text it wraps normally again.
    await box.fill("some real text")
    expect(await box.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap")
  })
})

// What someone reads when something goes wrong. Real failures are simulated at the
// network edge with the kinds of bodies servers and proxies actually produce.
test.describe("Error messages", () => {
  const GENERIC = "Something went wrong. Please try again."

  // The failed send has already created its (empty) conversation and the page
  // never leaves "/", so the afterEach above cannot find it by URL: note the id
  // from the create response and remove it here.
  const created: string[] = []
  test.afterEach(async ({ request }) => {
    for (const id of created.splice(0)) await request.delete(`${API}/conversations/${id}`)
  })

  async function sendAndReadError(page: Page, respond: Parameters<Page["route"]>[1]) {
    page.on("response", async (res) => {
      if (res.request().method() === "POST" && new URL(res.url()).pathname === "/conversations" && res.ok()) {
        created.push((await res.json()).id)
      }
    })
    await page.goto("/")
    await page.route("**/messages", respond)
    await page.getByPlaceholder(COMPOSER).fill("a vector has magnitude")
    await page.getByRole("button", { name: "Send" }).click()
    const alert = page.getByRole("alert")
    await expect(alert).toBeVisible()
    return alert
  }

  test("a server crash shows a plain sentence, not a status code", async ({ page }) => {
    const alert = await sendAndReadError(page, (route) =>
      route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" }),
    )
    await expect(alert).toContainText(GENERIC)
    await expect(alert).not.toContainText("500")
    await expect(alert).not.toContainText("Internal Server Error")
  })

  test("a proxy's HTML error page never reaches the screen", async ({ page }) => {
    const alert = await sendAndReadError(page, (route) =>
      route.fulfill({ status: 502, contentType: "text/html", body: "<html><h1>502 Bad Gateway</h1></html>" }),
    )
    await expect(alert).toContainText(GENERIC)
    await expect(alert).not.toContainText("Bad Gateway")
    await expect(alert).not.toContainText("<")
  })

  test("a validation error is not shown as [object Object]", async ({ page }) => {
    const alert = await sendAndReadError(page, (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ detail: [{ loc: ["body", "transcript"], msg: "field required", type: "missing" }] }),
      }),
    )
    await expect(alert).toContainText(GENERIC)
    await expect(alert).not.toContainText("[object")
    await expect(alert).not.toContainText("field required")
  })

  test("a message the server wrote for people is shown as written", async ({ page }) => {
    const alert = await sendAndReadError(page, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "The AI service isn't available right now. Please try again later." }),
      }),
    )
    await expect(alert).toContainText("The AI service isn't available right now. Please try again later.")
  })

  test("being offline says so without the browser's own wording", async ({ page }) => {
    const alert = await sendAndReadError(page, (route) => route.abort("failed"))
    await expect(alert).toContainText("Can't reach the server. Check your connection and try again.")
    await expect(alert).not.toContainText("Failed to fetch")
  })
})

