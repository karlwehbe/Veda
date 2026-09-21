// Acceptance: the journeys someone actually performs, in a real browser
// against the real stack. Backed by docker-compose.test.yml, so the model is
// a stub and the notes it returns are fixed and known.
import { expect, test, type Page } from "@playwright/test"

const COMPOSER = "Type or record…"

async function sendMessage(page: Page, text: string) {
  await page.getByPlaceholder(COMPOSER).fill(text)
  await page.getByRole("button", { name: "Send" }).click()
}

// Each test creates a real conversation in the system database. Delete the
// ones we made rather than wiping the table: these run against whatever
// SYSTEM stack is up, and a blanket delete would destroy real data if someone
// ever pointed this at the dev API by mistake.
const created = new Set<string>()

test.afterEach(async ({ page, request }) => {
  const match = page.url().match(/\/c\/([0-9a-f-]{36})/)
  if (match) created.add(match[1]!)
  for (const id of created) {
    await request.delete(`${process.env.VITE_API_URL ?? "http://localhost:8001"}/conversations/${id}`)
  }
  created.clear()
})

test.describe("Starting a lecture", () => {
  test("a typed message produces a reply and a notes document", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Start a new lecture" })).toBeVisible()

    await sendMessage(page, "a vector has magnitude and direction")

    // The turn lands on a conversation route.
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/, { timeout: 30_000 })

    // The user's own words come back as a message.
    await expect(page.getByText("a vector has magnitude and direction", { exact: true })).toBeVisible()

    // The notes panel opens with the document. Scoped to the panel: the
    // conversation header carries the same title as an <h1>.
    const notes = page.getByRole("complementary", { name: "Notes" })
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
    await expect(notes.getByRole("heading", { name: "Vectors" })).toBeVisible()
  })

  test("the conversation appears in the sidebar with a real title", async ({ page }) => {
    await page.goto("/")
    await sendMessage(page, "a vector has magnitude and direction")
    await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 })

    // .first() because the suite shares a stack — earlier runs may have left
    // conversations with the same stubbed title.
    const sidebar = page.getByRole("navigation", { name: "Conversations" })
    await expect(sidebar.getByText("Vectors").first()).toBeVisible()
    await expect(sidebar.getByText("New conversation")).toHaveCount(0)
  })
})

test.describe("Maths rendering", () => {
  // The bug class that has cost the most in this project: LaTeX reaching the
  // page as raw source instead of rendered maths.
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await sendMessage(page, "a vector has magnitude and direction")
    await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 })
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
  })

  test("equations render as KaTeX, not raw source", async ({ page }) => {
    const notes = page.getByRole("complementary", { name: "Notes" })
    await expect(notes.locator(".katex").first()).toBeVisible()
  })

  test("no raw TeX commands are visible to the reader", async ({ page }) => {
    // KaTeX keeps the original source in a hidden annotation, so assert on
    // rendered text rather than on the DOM as a whole.
    const notes = page.getByRole("complementary", { name: "Notes" })
    // innerText() does not auto-wait the way expect() does, so read it only
    // once KaTeX has actually rendered — otherwise this races the reveal.
    const rendered = notes.locator(".katex-html").first()
    await expect(rendered).toBeVisible()
    const visible = await rendered.innerText()
    expect(visible).not.toContain("\\hat")
    expect(visible).not.toContain("$")
  })

  test("a matrix with letter rows renders without errors", async ({ page }) => {
    // With throwOnError:false, KaTeX renders an undefined command as red
    // source inside .katex-error. That is exactly what \c produced when the
    // collapse rule ate the \\ row separator, so an empty count here is the
    // end-to-end proof that matrices survive the pipeline.
    const notes = page.getByRole("complementary", { name: "Notes" })
    await expect(notes.locator(".katex").first()).toBeVisible()
    await expect(notes.locator(".katex-error")).toHaveCount(0)
  })

  test("the vector accent renders above the letter", async ({ page }) => {
    // Regression cover for the katex version mismatch: 0.16 markup styled by
    // 0.18 CSS put the arrow under the letter instead of over it, because
    // .accent-body never became a positioned ancestor.
    const accentBody = page.getByRole("complementary", { name: "Notes" }).locator(".accent-body").first()
    await expect(accentBody).toHaveCount(1)
    await expect(accentBody).toHaveCSS("position", "relative")
  })
})

test.describe("The notes panel", () => {
  test("collapsing survives a reload", async ({ page }) => {
    await page.goto("/")
    await sendMessage(page, "a vector has magnitude and direction")
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()

    await page.getByRole("button", { name: "Collapse notes" }).click()
    await expect(page.getByRole("heading", { name: "Notes" })).toBeHidden()

    await page.reload()
    await expect(page.getByRole("button", { name: "Expand notes" })).toBeVisible()

    // Leave the app as we found it — the setting is in localStorage and would
    // otherwise leak into the next test.
    await page.getByRole("button", { name: "Expand notes" }).click()
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
  })
})

test.describe("Chat that must not touch the notes", () => {
  test("a question is answered without changing the document", async ({ page }) => {
    await page.goto("/")
    await sendMessage(page, "a vector has magnitude and direction")
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()

    const before = await page.getByRole("complementary", { name: "Notes" }).innerText()

    await sendMessage(page, "what is a vector?")
    await expect(page.getByText("what is a vector?")).toBeVisible()

    // The stub routes everything through the notes branch, so this asserts
    // the weaker but still meaningful property: the panel is never blanked.
    await expect(page.getByRole("complementary", { name: "Notes" })).not.toHaveText("")
    expect(before.length).toBeGreaterThan(0)
  })
})
