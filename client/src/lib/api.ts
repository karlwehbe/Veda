// Thin fetch wrappers for the server's /conversations API — keeps the actual
// endpoint URLs and response shapes in one place instead of duplicated
// across the sidebar, composer, and conversation page.
export const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:8000"

// Same host as apiUrl, but ws(s):// instead of http(s):// — used to connect
// to the live-transcription proxy at /ws/transcribe.
export const wsApiUrl = apiUrl.replace(/^http/, "ws")

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  filename: string | null
  created_at: string
}

export type Conversation = {
  id: string
  title: string
  // null = not in any project — shows in the sidebar's flat "Chats" list.
  project_id: string | null
  created_at: string
  updated_at: string
}

// A folder grouping conversations — a course, a research project, a reading
// group. Flat: a project holds conversations directly and cannot contain
// other projects. See server/app/api/projects.py.
export type Project = {
  id: string
  name: string
  type: string
  // What this project is about, in the user's own words — shown back on
  // the project page. Descriptive, unlike `instructions` below: never sent
  // to the writer.
  description: string
  // The user's own words, sent to the writer verbatim — same treatment as
  // the profile's Instructions field. Not private: this is what they typed.
  instructions: string
  conversation_count: number
  created_at: string
  updated_at: string
}

export type ProjectDetail = Project & {
  conversations: Conversation[]
}

export type ConversationDetail = Conversation & {
  messages: Message[]
  // With each slide's image markdown already injected — see
  // server/app/services/slides.py.
  note_content: string | null
  draft_transcript: string | null
  slide_count: number
}

export type MessageTurn = {
  user_message: Message
  assistant_message: Message
  note_content: string | null
  title: string
  slide_count: number
}

// One page of an uploaded slide deck. The whole deck is kept, so every page
// is listed whether or not it is in the notes.
export type Slide = {
  id: string
  // The PDF it came from. null only for slides stored before decks were kept:
  // those can be removed but not added back.
  deck_id: string | null
  deck_name: string | null
  position: number
  page_number: number
  alt: string
  // In the notes (checked in the slides dialog) or just kept in the deck.
  included: boolean
  // An included slide with no spot in the notes yet: kept, hidden, and retried
  // after every notes update.
  placed: boolean
}

// What every slide mutation returns: every page of every deck, and the notes
// with the included slides injected so the panel can update without a refetch.
export type SlidesResult = {
  slides: Slide[]
  note_content: string | null
}

export type DeckUploadResult = SlidesResult & { deck_id: string }

// The personal context layer: a short profile compiled by an LLM into a
// description of the user that rides along on every note/chat prompt.
// See server/app/api/profile.py.
export type ProfileFields = {
  occupation: string
  background_level: string
  education_level: string
  notes_purpose: string[]
  emphasize: string[]
  // The user's own directions for the AI. Sent to the writer verbatim.
  instructions: string
}

// No compiled_prompt: the server still compiles a description of the user
// from these answers, but it is private and never sent to the client.
export type UserProfileState = {
  name: string
  fields: ProfileFields
  has_profile: boolean
}

/** What someone sees when we have nothing more specific to say. No status codes,
 *  no stack, no hints about servers or deploys. */
export const GENERIC_ERROR = "Something went wrong. Please try again."

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${apiUrl}${path}`, init)
  } catch {
    // fetch() itself throwing means the request never reached the server
    // (offline, DNS failure, connection refused) — the raw browser message
    // for that ("Failed to fetch", "NetworkError...") isn't something to
    // show someone using the app.
    throw new Error("Can't reach the server. Check your connection and try again.")
  }
  if (!res.ok) {
    // Only a string detail is a message written for people. FastAPI's validation
    // errors carry an array of objects, which would otherwise be shown as
    // "[object Object]".
    const message = await res
      .json()
      .then((body: { detail?: unknown }) => (typeof body.detail === "string" ? body.detail : undefined))
      .catch(() => undefined)
    // The status is for whoever is debugging, not for the person using the app.
    console.error(`API error ${res.status} for ${init?.method ?? "GET"} ${path}`, message ?? "")
    // FastAPI's own "no such route" 404 has this exact body; every handler in
    // this app raises its 404s with a specific detail instead. So the server has
    // no such endpoint — the page and the server are out of step, typically just
    // after an update. A refresh loads the matching page.
    if (res.status === 404 && message === "Not Found") {
      throw new Error("This isn't available right now. Please refresh the page and try again.")
    }
    throw new Error(message || GENERIC_ERROR)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  listConversations: () => request<Conversation[]>("/conversations"),
  // projectId files the new conversation there from creation — the project
  // page's "New chat" button passes its own id; the sidebar's plain "New
  // chat" and a recording started from elsewhere omit it (ungrouped).
  createConversation: (projectId?: string) =>
    request<Conversation>(
      `/conversations${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
      { method: "POST" },
    ),
  getConversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  // File upload path — audio bytes only; server batch-transcribes via Deepgram.
  sendMessage: (conversationId: string, audio: Blob, filename: string) => {
    const formData = new FormData()
    formData.append("file", audio, filename)
    return request<MessageTurn>(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: formData,
    })
  },
  // Live recording path — transcript already captured via /ws/transcribe.
  // filename marks the turn as a recording without uploading audio bytes.
  sendLiveRecordingMessage: (
    conversationId: string,
    transcript: string,
    filename = "recording.webm",
  ) => {
    const formData = new FormData()
    formData.append("transcript", transcript)
    formData.append("filename", filename)
    return request<MessageTurn>(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: formData,
    })
  },
  sendTextMessage: (conversationId: string, text: string) => {
    const formData = new FormData()
    formData.append("transcript", text)
    return request<MessageTurn>(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: formData,
    })
  },
  // Fire-and-forget autosave of the transcript captured so far while a
  // recording is in progress — see conversations.py's save_draft.
  // keepalive: true so the request still completes when the composer
  // unmounts mid-navigation (otherwise the browser may cancel it).
  saveDraftTranscript: (conversationId: string, transcript: string) =>
    request<void>(`/conversations/${conversationId}/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
      keepalive: true,
    }),
  // Keeps the whole PDF with the conversation — a thumbnail and the text of every
  // page — without putting anything in the notes or calling a model.
  uploadSlideDeck: (conversationId: string, file: File) => {
    const formData = new FormData()
    formData.append("file", file)
    return request<DeckUploadResult>(`/conversations/${conversationId}/slides/decks`, {
      method: "POST",
      body: formData,
    })
  },
  listSlides: (conversationId: string) => request<Slide[]>(`/conversations/${conversationId}/slides`),
  // Put pages in the notes / take pages out. Only the named pages are touched:
  // added ones are rendered and placed, removed ones just leave the notes (and
  // stay in the deck to be added back later).
  changeSlides: (conversationId: string, change: { add: string[]; remove: string[] }) =>
    request<SlidesResult>(`/conversations/${conversationId}/slides`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    }),
  // Forget an uploaded PDF entirely (unlike un-ticking a page, which keeps it).
  deleteSlideDeck: (conversationId: string, deckId: string) =>
    request<SlidesResult>(`/conversations/${conversationId}/slides/decks/${deckId}`, { method: "DELETE" }),
  getProfile: () => request<UserProfileState>("/profile"),
  saveProfile: (input: { name: string; fields: ProfileFields }) =>
    request<UserProfileState>("/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  deleteProfile: () => request<void>("/profile", { method: "DELETE" }),

  listProjects: () => request<Project[]>("/projects"),
  getProject: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  createProject: (input: { name: string; type: string; description: string; instructions: string }) =>
    request<Project>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  updateProject: (
    id: string,
    input: { name: string; type: string; description: string; instructions: string },
  ) =>
    request<Project>(`/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  // Destructive: also deletes every conversation filed under this project,
  // and their notes and messages with them (server-side ON DELETE CASCADE).
  // The caller is responsible for confirming with the user first.
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),
}
