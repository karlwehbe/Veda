// What a person reads when a request fails. The server and the network can fail
// in ways that produce developer text — status codes, "[object Object]", hints
// about deploys — and none of it should reach the screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GENERIC_ERROR, api } from "./api"

function respond(status: number, body: unknown, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status, headers: { "Content-Type": contentType } })))
}

async function messageOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call()
  } catch (err) {
    return (err as Error).message
  }
  throw new Error("expected the request to fail")
}

// The status and path are logged for whoever is debugging; keep that out of test output.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("a request that fails", () => {
  it("shows the server's own message when it wrote one for people", async () => {
    respond(400, { detail: "That file is empty." })
    expect(await messageOf(() => api.listSlides("c1"))).toBe("That file is empty.")
  })

  it("never shows an HTTP status code", async () => {
    respond(500, "Internal Server Error", "text/plain")
    const message = await messageOf(() => api.listSlides("c1"))
    expect(message).toBe(GENERIC_ERROR)
    expect(message).not.toMatch(/\b\d{3}\b/)
    expect(message.toLowerCase()).not.toContain("error 500")
  })

  it("falls back to the same plain sentence for an unreadable body", async () => {
    respond(502, "<html><body>Bad Gateway</body></html>", "text/html")
    expect(await messageOf(() => api.listSlides("c1"))).toBe(GENERIC_ERROR)
  })

  it("does not show a validation error as [object Object]", async () => {
    // FastAPI's 422 carries an array of objects in `detail`, not a string.
    respond(422, { detail: [{ loc: ["body", "add", 0], msg: "value is not a valid uuid", type: "uuid_parsing" }] })
    const message = await messageOf(() => api.changeSlides("c1", { add: ["nope"], remove: [] }))
    expect(message).toBe(GENERIC_ERROR)
    expect(message).not.toContain("[object")
    expect(message).not.toContain("uuid")
  })

  it("does not pass on a non-string detail of any other shape", async () => {
    respond(400, { detail: { code: "E_BAD", trace: "at x.py:12" } })
    expect(await messageOf(() => api.listSlides("c1"))).toBe(GENERIC_ERROR)
  })

  it("says nothing about deploys when the server has no such endpoint", async () => {
    // FastAPI's own "no such route" body: the page and the server are out of step.
    respond(404, { detail: "Not Found" })
    const message = await messageOf(() => api.listSlides("c1"))
    expect(message).toBe("This isn't available right now. Please refresh the page and try again.")
    for (const developerWord of ["redeploy", "rebuild", "docker", "server is", "./", "version"]) {
      expect(message.toLowerCase()).not.toContain(developerWord)
    }
  })

  it("keeps a specific 404 message rather than the generic one", async () => {
    respond(404, { detail: "We couldn't find that conversation. It may have been deleted." })
    expect(await messageOf(() => api.getConversation("gone"))).toContain("couldn't find that conversation")
  })

  it("explains a network failure without the browser's own wording", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))))
    const message = await messageOf(() => api.listSlides("c1"))
    expect(message).toBe("Can't reach the server. Check your connection and try again.")
    expect(message).not.toContain("Failed to fetch")
  })

  it("logs the status for debugging without showing it", async () => {
    respond(503, { detail: "The AI service isn't available right now. Please try again later." })
    await messageOf(() => api.listSlides("c1"))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("503"), expect.anything())
  })
})

describe("a request that succeeds", () => {
  it("returns the body", async () => {
    respond(200, [{ id: "s1" }])
    expect(await api.listSlides("c1")).toEqual([{ id: "s1" }])
  })

  it("returns nothing for a 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })))
    expect(await api.deleteConversation("c1")).toBeUndefined()
  })
})
