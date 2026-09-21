// Acceptance: an uploaded PDF is kept whole with the conversation. The slides
// dialog shows every page with a check on the ones in the notes; ticking a page
// adds only that page, unticking removes only that page, and a removed page stays
// in the deck to be ticked again without uploading. Backed by the stubbed stack —
// its SlidePlacements answer places slides 1-4 (after the first bullet list) and
// has no answer for anything after that, so a second deck's pages have no spot.
import { fileURLToPath } from "node:url"

import { expect, test, type Locator, type Page } from "@playwright/test"

const COMPOSER = "Type or record…"
const DECK = fileURLToPath(new URL("./fixtures/deck.pdf", import.meta.url)) // 4 pages
const API = process.env.VITE_API_URL ?? "http://localhost:8001"

test.afterEach(async ({ page, request }) => {
  const match = page.url().match(/\/c\/([0-9a-f-]{36})/)
  if (match) await request.delete(`${API}/conversations/${match[1]}`)
})

async function startNotes(page: Page) {
  await page.goto("/")
  await page.getByPlaceholder(COMPOSER).fill("a vector has magnitude and direction")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/, { timeout: 30_000 })
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
}

// The "+" in the composer opens on hover, like the record-source menu. The menu
// is driven by mouseenter, so a hover only opens it if the pointer actually
// arrives from outside: park the pointer elsewhere first, and retry as a whole
// (a slow machine can re-render the composer between the hover and the check).
async function openAddMenu(page: Page) {
  await expect(async () => {
    await page.mouse.move(5, 5)
    await page.getByRole("button", { name: "Add files" }).hover()
    await expect(page.getByRole("menu", { name: "Add files" })).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

const notesPanel = (page: Page) => page.getByRole("complementary", { name: "Notes" })
const slideImages = (page: Page) => notesPanel(page).locator("img[src*='/slides/']")
// Exact: "Slides" would otherwise also match "Reading your slides".
const slidesDialog = (page: Page) => page.getByRole("dialog", { name: "Slides", exact: true })
const fileInput = (page: Page) => page.locator('input[type="file"][aria-label="Choose a slides PDF"]')

async function openManage(page: Page): Promise<Locator> {
  await openAddMenu(page)
  await page.getByRole("menuitem", { name: "Manage slides" }).click()
  const dialog = slidesDialog(page)
  await expect(dialog).toBeVisible()
  return dialog
}

/** Choose a PDF: it is kept, and the dialog opens with all its pages ticked. */
async function chooseDeck(page: Page, path = DECK): Promise<Locator> {
  await fileInput(page).setInputFiles(path)
  const dialog = slidesDialog(page)
  await expect(dialog.getByRole("checkbox").first()).toBeVisible({ timeout: 20_000 })
  return dialog
}

async function save(page: Page, dialog: Locator) {
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

/** Upload the deck and keep only the first `keep` pages in the notes. */
async function addSlides(page: Page, keep: number) {
  const dialog = await chooseDeck(page)
  await expect(dialog.getByRole("checkbox")).toHaveCount(4)
  // Every page starts ticked; untick from the end until `keep` remain.
  for (let i = 4; i > keep; i--) await dialog.getByRole("checkbox").nth(i - 1).click()
  await save(page, dialog)
}

const ticked = (dialog: Locator) => dialog.getByRole("checkbox").evaluateAll((boxes) => boxes.map((b) => b.getAttribute("aria-checked") === "true"))

type Recorded = { method: string; url: string; body: string | null }
/** Every request the page makes about slides, so a test can say what was — and was not — sent. */
function trackSlideRequests(page: Page): Recorded[] {
  const seen: Recorded[] = []
  page.on("request", (r) => {
    if (/\/slides/.test(r.url()) && r.method() !== "GET") seen.push({ method: r.method(), url: r.url(), body: r.postData() })
  })
  return seen
}
const patches = (seen: Recorded[]) => seen.filter((r) => r.method === "PATCH").map((r) => JSON.parse(r.body ?? "{}") as { add: string[]; remove: string[] })
const uploads = (seen: Recorded[]) => seen.filter((r) => r.method === "POST" && r.url.endsWith("/slides/decks"))

test.describe("Slides", () => {
  test("can't be added until the notes exist", async ({ page }) => {
    await page.goto("/")
    // A conversation with no notes yet: create it eagerly the way a project's
    // "New chat" does, and open it.
    const created = await page.request.post(`${API}/conversations`)
    const { id } = (await created.json()) as { id: string }
    await page.goto(`/c/${id}`)
    await openAddMenu(page)
    await expect(page.getByRole("menuitem", { name: "Upload slides" })).toBeDisabled()
    // Audio upload is unaffected.
    await expect(page.getByRole("menuitem", { name: "Upload audio file" })).toBeEnabled()
  })

  test("the + menu offers the audio and slides uploads, and slides open the dialog", async ({ page }) => {
    await startNotes(page)
    await openAddMenu(page)

    const menu = page.getByRole("menu", { name: "Add files" })
    await expect(menu.getByRole("menuitem")).toHaveText(["Upload audio file", "Upload slides"])
    await expect(menu.getByRole("menuitem", { name: "Upload slides" })).toBeEnabled()

    const chooser = page.waitForEvent("filechooser")
    await menu.getByRole("menuitem", { name: "Upload slides" }).click()
    await (await chooser).setFiles(DECK)

    await expect(slidesDialog(page)).toBeVisible({ timeout: 20_000 })
  })

  test("the audio item opens an audio-only file chooser", async ({ page }) => {
    await startNotes(page)
    await openAddMenu(page)
    const chooser = page.waitForEvent("filechooser")
    await page.getByRole("menuitem", { name: "Upload audio file" }).click()
    expect(await page.locator('input[type="file"][accept="audio/*"]').count()).toBe(1)
    await chooser
  })

  test("a new PDF opens with every page ticked; saving puts the ticked pages in the notes", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 3)

    await expect(slideImages(page)).toHaveCount(3)
    // The images really load from the API (not just present in the DOM).
    await expect
      .poll(() =>
        slideImages(page).evaluateAll((imgs) =>
          imgs.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true)
  })

  test("slides sit after the section they belong to, not at the end", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 2)

    const order = await notesPanel(page).evaluate((panel) => {
      const nodes = [...panel.querySelectorAll("li, img, .katex-display")]
      return nodes.map((n) => (n.tagName === "IMG" ? "img" : n.tagName === "LI" ? "li" : "math"))
    })
    const firstImg = order.indexOf("img")
    expect(order.slice(0, firstImg)).toContain("li")
    // The display equation that follows the bullet list comes after the slides.
    expect(order.indexOf("math")).toBeGreaterThan(firstImg)
    expect(order.lastIndexOf("img")).toBeLessThan(order.indexOf("math"))
  })

  test("the whole PDF is kept: the dialog lists every page, checked where it is in the notes", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 3)

    const dialog = await openManage(page)
    await expect(dialog.getByRole("checkbox")).toHaveCount(4)
    expect(await ticked(dialog)).toEqual([true, true, true, false])
    const deck = dialog.getByRole("region", { name: "deck.pdf" })
    await expect(deck).toContainText("3 of 4 in your notes")
    // The page that is not in the notes is still shown, ready to add.
    await expect(deck.getByRole("checkbox").nth(3)).toHaveAttribute("aria-checked", "false")
  })

  test("adding one more page sends only that page — nothing is uploaded again, nothing already there is redone", async ({
    page,
  }) => {
    await startNotes(page)
    await addSlides(page, 3)
    const seen = trackSlideRequests(page)

    const dialog = await openManage(page)
    await dialog.getByRole("checkbox").nth(3).click()
    await expect(dialog.getByText("Adding 1")).toBeVisible()
    await save(page, dialog)

    await expect(slideImages(page)).toHaveCount(4)
    expect(uploads(seen)).toHaveLength(0)
    const [change] = patches(seen)
    expect(patches(seen)).toHaveLength(1)
    expect(change!.add).toHaveLength(1)
    expect(change!.remove).toHaveLength(0)
  })

  test("removing a page sends only that page, and it stays in the deck to add back without uploading", async ({
    page,
  }) => {
    await startNotes(page)
    await addSlides(page, 4)
    await expect(slideImages(page)).toHaveCount(4)
    const seen = trackSlideRequests(page)

    // Remove page 2.
    let dialog = await openManage(page)
    await dialog.getByRole("checkbox").nth(1).click()
    await expect(dialog.getByText("Removing 1")).toBeVisible()
    await save(page, dialog)

    await expect(slideImages(page)).toHaveCount(3)
    expect(patches(seen)).toHaveLength(1)
    expect(patches(seen)[0]!.remove).toHaveLength(1)
    expect(patches(seen)[0]!.add).toHaveLength(0)

    // It is still in the deck, unticked...
    dialog = await openManage(page)
    await expect(dialog.getByRole("checkbox")).toHaveCount(4)
    expect(await ticked(dialog)).toEqual([true, false, true, true])
    // ...and ticking it again brings it back with no second upload.
    await dialog.getByRole("checkbox").nth(1).click()
    await save(page, dialog)
    await expect(slideImages(page)).toHaveCount(4)
    expect(uploads(seen)).toHaveLength(0)
    expect(patches(seen)).toHaveLength(2)
    expect(patches(seen)[1]!.add).toHaveLength(1)
    expect(patches(seen)[1]!.remove).toHaveLength(0)
  })

  test("adding and removing in one save sends exactly those changes", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 2)
    const seen = trackSlideRequests(page)

    const dialog = await openManage(page)
    await dialog.getByRole("checkbox").nth(0).click() // remove page 1
    await dialog.getByRole("checkbox").nth(3).click() // add page 4
    await expect(dialog.getByText("Adding 1 · Removing 1")).toBeVisible()
    await save(page, dialog)

    expect(patches(seen)).toEqual([{ add: [expect.any(String)], remove: [expect.any(String)] }])
    await expect(slideImages(page)).toHaveCount(2)
  })

  test("Save is off until something changes, and closing without saving sends nothing", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 3)
    const seen = trackSlideRequests(page)

    const dialog = await openManage(page)
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled()
    await expect(dialog.getByText("No changes")).toBeVisible()

    // Change something, change it back: still nothing to save.
    await dialog.getByRole("checkbox").nth(3).click()
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeEnabled()
    await dialog.getByRole("checkbox").nth(3).click()
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled()

    // Leave a change unsaved and close: nothing goes to the server, notes unchanged.
    await dialog.getByRole("checkbox").nth(0).click()
    await dialog.getByRole("button", { name: "Close" }).click()
    await expect(dialog).toBeHidden()
    expect(seen).toHaveLength(0)
    await expect(slideImages(page)).toHaveCount(3)
  })

  test("closing the dialog after an upload keeps the PDF, with nothing in the notes yet", async ({ page }) => {
    await startNotes(page)
    let dialog = await chooseDeck(page)
    await dialog.getByRole("button", { name: "Close" }).click() // never saved
    await expect(dialog).toBeHidden()
    await expect(slideImages(page)).toHaveCount(0)

    // The menu now offers Manage slides, and the whole deck is there — unticked.
    dialog = await openManage(page)
    await expect(dialog.getByRole("checkbox")).toHaveCount(4)
    expect(await ticked(dialog)).toEqual([false, false, false, false])
    await expect(dialog.getByRole("region", { name: "deck.pdf" })).toContainText("0 of 4 in your notes")
  })

  test("a second PDF sits beside the first; adding its pages leaves the first alone", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 3)
    const seen = trackSlideRequests(page)

    let dialog = await openManage(page)
    const chooser = page.waitForEvent("filechooser")
    await dialog.getByRole("button", { name: "Upload another PDF" }).click()
    await (await chooser).setFiles(DECK)

    // Both decks are listed: the first as it was, the new one ticked.
    dialog = slidesDialog(page)
    await expect(dialog.getByRole("checkbox")).toHaveCount(8, { timeout: 20_000 })
    expect(await ticked(dialog)).toEqual([true, true, true, false, true, true, true, true])
    await expect(dialog.getByRole("region")).toHaveCount(2)
    // Saving sends just the new deck's four pages — none of the first deck's.
    await save(page, dialog)
    expect(uploads(seen)).toHaveLength(1)
    expect(patches(seen)).toHaveLength(1)
    expect(patches(seen)[0]!.add).toHaveLength(4)
    expect(patches(seen)[0]!.remove).toHaveLength(0)
  })

  test("a page with no spot in the notes is hidden, announced, and labelled in the dialog", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 4) // the stub places these four...
    await expect(slideImages(page)).toHaveCount(4)
    await expect(notesPanel(page).getByRole("status")).toHaveCount(0)

    // ...and has no answer for a second deck's pages.
    let dialog = await openManage(page)
    const chooser = page.waitForEvent("filechooser")
    await dialog.getByRole("button", { name: "Upload another PDF" }).click()
    await (await chooser).setFiles(DECK)
    dialog = slidesDialog(page)
    await expect(dialog.getByRole("checkbox")).toHaveCount(8, { timeout: 20_000 })
    for (let i = 7; i > 4; i--) await dialog.getByRole("checkbox").nth(i).click() // keep only its first page
    await save(page, dialog)

    // Hidden: not dumped under a "Slides" heading at the end of the notes.
    await expect(slideImages(page)).toHaveCount(4)
    await expect(notesPanel(page).getByRole("heading", { name: "Slides" })).toHaveCount(0)

    // But not silent.
    const notice = notesPanel(page).getByRole("status")
    await expect(notice).toContainText("1 of 5 slides isn't in your notes yet")
    await notice.getByRole("button", { name: "Dismiss" }).click()
    await expect(notesPanel(page).getByRole("status")).toHaveCount(0)

    dialog = await openManage(page)
    await expect(dialog.getByText("Page 1 · Not placed yet")).toBeVisible()
  })

  test("removing a PDF forgets it and its pages leave the notes", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 3)
    await expect(slideImages(page)).toHaveCount(3)

    const dialog = await openManage(page)
    await dialog.getByRole("button", { name: "Remove deck.pdf" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()

    await expect(dialog).toBeHidden()
    await expect(slideImages(page)).toHaveCount(0)
    // Nothing left: the menu goes back to Upload slides. The notes text is untouched.
    await openAddMenu(page)
    await expect(page.getByRole("menuitem", { name: "Upload slides" })).toBeEnabled()
    await expect(page.getByRole("menuitem", { name: /Manage slides/ })).toHaveCount(0)
    await expect(notesPanel(page).getByRole("heading", { name: "Vectors" })).toBeVisible()
  })

  test("slide images never grow past 640px, however wide the notes panel is", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 1)
    const image = slideImages(page).first()
    await expect(image).toBeVisible()

    // At the default panel width the image simply fills it (under the cap).
    // (Polled: the image can be re-rendered just after it first appears.)
    await expect.poll(async () => (await image.boundingBox())?.width ?? NaN).toBeLessThan(640)

    // Make the notes very wide: a big window, then drag the panel's edge out.
    await page.setViewportSize({ width: 1800, height: 900 })
    const panel = notesPanel(page)
    const handle = (await panel.locator("div.cursor-col-resize").boundingBox())!
    const y = handle.y + handle.height / 2
    await page.mouse.move(handle.x + handle.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(60, y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeGreaterThan(1000)

    // The panel is over 1000px wide, but the slide stops at 640px and is centred.
    await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(640)
    const p = (await panel.boundingBox())!
    const i = (await image.boundingBox())!
    expect(Math.abs(i.x + i.width / 2 - (p.x + p.width / 2))).toBeLessThan(20)
  })

  test("slides in the notes have no remove button of their own", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 3)
    await slideImages(page).first().hover()
    await expect(notesPanel(page).getByRole("button", { name: "Remove slide" })).toHaveCount(0)
  })

  test("the menu says Manage slides once a PDF is kept, with no count, and Upload slides before", async ({ page }) => {
    await startNotes(page)
    await openAddMenu(page)
    const menu = page.getByRole("menu", { name: "Add files" })
    await expect(menu.getByRole("menuitem")).toHaveText(["Upload audio file", "Upload slides"])
    await page.mouse.move(600, 100)

    await addSlides(page, 3)
    await openAddMenu(page)
    await expect(menu.getByRole("menuitem")).toHaveText(["Upload audio file", "Manage slides"])
  })

  test("the X closes the dialog", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 2)
    const dialog = await openManage(page)
    await dialog.getByRole("button", { name: "Close" }).click()
    await expect(dialog).toBeHidden()
    await expect(slideImages(page)).toHaveCount(2)
  })

  test("reading the PDF shows its loading state in the dialog, not on the page behind", async ({ page }) => {
    await startNotes(page)
    // Hold the upload response so the loading state is observable.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    await page.route("**/slides/decks", async (route) => {
      await gate
      await route.continue()
    })

    await fileInput(page).setInputFiles(DECK)

    const loading = page.getByRole("dialog", { name: "Reading your slides" })
    await expect(loading).toBeVisible()
    await expect(loading.getByRole("status")).toContainText("Reading every page")
    // Nothing is announced up under the conversation title.
    await expect(page.getByRole("status")).toHaveCount(1)

    release()
    await expect(slidesDialog(page).getByRole("checkbox")).toHaveCount(4, { timeout: 20_000 })
  })

  test("a non-PDF is refused inside the dialog, with a way to pick another file", async ({ page }) => {
    await startNotes(page)
    await fileInput(page).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a pdf") })

    const modal = page.getByRole("dialog", { name: "Couldn't add these slides" })
    await expect(modal.getByRole("alert")).toContainText("Only PDF files")
    // Not shown anywhere else on the page.
    await expect(page.getByRole("alert")).toHaveCount(1)

    const chooser = page.waitForEvent("filechooser")
    await modal.getByRole("button", { name: "Choose another file" }).click()
    await expect(modal).toBeHidden()
    await (await chooser).setFiles(DECK)
    await expect(slidesDialog(page).getByRole("checkbox")).toHaveCount(4, { timeout: 20_000 })
  })

  test("a PDF the server can't read shows the server's reason, and keeps nothing", async ({ page }) => {
    await startNotes(page)
    await fileInput(page).setInputFiles({
      name: "broken.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("this is not really a pdf"),
    })

    const modal = page.getByRole("dialog", { name: "Couldn't add these slides" })
    await expect(modal.getByRole("alert")).toContainText("isn't a readable PDF")
    await modal.getByRole("button", { name: "Close" }).click()
    await expect(modal).toBeHidden()
    // Nothing was kept: the menu still offers Upload slides.
    await openAddMenu(page)
    await expect(page.getByRole("menuitem", { name: "Upload slides" })).toBeEnabled()
  })

  test("an endpoint the server does not have reads as a plain, actionable sentence", async ({ page }) => {
    await startNotes(page)
    // FastAPI's own body for a route that doesn't exist — the page and the server
    // out of step. Nothing about servers, versions or deploys reaches the person.
    await page.route("**/slides/decks", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Not Found" }) }),
    )
    await fileInput(page).setInputFiles(DECK)

    const modal = page.getByRole("dialog", { name: "Couldn't add these slides" })
    const alert = modal.getByRole("alert")
    await expect(alert).toContainText("Please refresh the page and try again.")
    for (const developerWord of ["redeploy", "rebuild", "version", "server"]) {
      await expect(alert).not.toContainText(developerWord, { ignoreCase: true })
    }
    await modal.getByRole("button", { name: "Close" }).click()
    await expect(modal).toBeHidden()
  })

  test("everything survives a reload and a further turn", async ({ page }) => {
    await startNotes(page)
    await addSlides(page, 2)
    await expect(slideImages(page)).toHaveCount(2)

    await page.reload()
    await expect(slideImages(page)).toHaveCount(2)
    // The whole deck is still there, with the same two ticked.
    const dialog = await openManage(page)
    expect(await ticked(dialog)).toEqual([true, true, false, false])
    await dialog.getByRole("button", { name: "Close" }).click()

    await page.getByPlaceholder(COMPOSER).fill("and the dot product is a scalar")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.getByText("Started your notes on vectors.").nth(1)).toBeVisible({ timeout: 30_000 })
    await expect(slideImages(page)).toHaveCount(2)
  })
})
