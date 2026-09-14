import { chromium } from "playwright-core"
const fs = await import("fs")
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
const execPath = CHROME_PATHS.find((p) => fs.existsSync(p))
const browser = await chromium.launch({ executablePath: execPath, headless: true })
const context = await browser.newContext({ deviceScaleFactor: 3 })
const page = await context.newPage()
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" })
await page.waitForTimeout(1000)
const projectLink = page.getByRole("link", { name: /COMP585/ })
await projectLink.waitFor({ state: "visible", timeout: 10000 })
await projectLink.click()
await page.waitForTimeout(600)
const row = page.locator("main, div").getByRole("link", { name: /New conversation/ }).first()
await row.hover()
await page.waitForTimeout(200)
const box = await row.boundingBox()
await page.screenshot({
  path: "/tmp/overflow-zoom.png",
  clip: { x: box.x - 10, y: box.y + box.height - 15, width: box.width + 20, height: 40 },
})
await browser.close()
console.log("done", JSON.stringify(box))
