# How Veda fits together

The overview: what the pieces are, how a request travels through them, and where each
kind of state lives. It is deliberately short. The detailed flows — with the real files and
functions named, so a diagram can be traced straight into the code — live in one page per
feature; the [feature map](#4-feature-map) below links to each.

- [1. System overview](#1-system-overview)
- [2. Data model](#2-data-model)
- [3. One turn, end to end](#3-one-turn-end-to-end)
- [4. Feature map](#4-feature-map)
- [5. Where state lives](#5-where-state-lives)

---

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser["Browser (React + TanStack Router)"]
    UI["Sidebar and routes<br/>index.tsx, c.$conversationId.tsx, p.$projectId.tsx"]
    LC["LayoutProvider<br/>lib/layout-context.tsx"]
    RC["RecordingProvider<br/>lib/recording-context.tsx<br/><i>above the router</i>"]
    CC["ChatComposer<br/>components/chat-composer.tsx"]
    SD["SlidesDialog<br/>components/slides-dialog.tsx"]
    MD["Markdown renderer<br/>components/markdown.tsx"]
    API["api client<br/>lib/api.ts"]
  end

  subgraph Server["FastAPI (server/app)"]
    CONV["/conversations<br/>api/conversations.py"]
    PRJ["/projects<br/>api/projects.py"]
    SL["/conversations/{id}/slides<br/>api/slides.py"]
    PR["/profile<br/>api/profile.py"]
    WS["/ws/transcribe<br/>api/live_transcribe.py"]
    GRAPH["notes_graph.py<br/>LangGraph: classify → notes / chat"]
    SVC["services/slides.py<br/>read, render, place slides"]
    TR["transcription.py<br/>batch STT"]
  end

  DB[("Postgres<br/>conversations, messages, projects,<br/>slide_decks, slides, user_profiles")]
  DG["Deepgram<br/>live + batch STT"]
  LLM["OpenAI<br/>via init_chat_model<br/><i>LLM_MODEL + ROUTING_LLM_MODEL</i>"]

  UI --> CC
  UI --> LC
  RC -.->|shared recording state| CC
  CC --> API
  SD --> API
  API -->|REST| CONV
  API -->|REST| PRJ
  API -->|REST| SL
  API -->|REST| PR
  RC -->|WebSocket audio| WS
  WS <-->|proxied stream| DG
  CONV --> TR --> DG
  CONV --> GRAPH --> LLM
  CONV --> SVC
  SL --> SVC
  SVC -->|placement| LLM
  PR --> GRAPH
  CONV --> DB
  PRJ --> DB
  SL --> DB
  PR --> DB
  GRAPH -->|"reads the compiled profile<br/>and project Instructions"| DB
```

The Deepgram API key never reaches the browser: `/ws/transcribe` proxies the live stream
server-side. There is no sign-in — one profile row, one set of conversations, global to
whoever opens the page.

---

## 2. Data model

```mermaid
erDiagram
  PROJECTS ||--o{ CONVERSATIONS : "files"
  CONVERSATIONS ||--o{ MESSAGES : has
  CONVERSATIONS ||--o{ SLIDE_DECKS : has
  CONVERSATIONS ||--o{ SLIDES : has
  SLIDE_DECKS ||--o{ SLIDES : "one per page"

  PROJECTS {
    uuid id PK
    string name
    string type "free text: Course, Research…"
    text description "shown to the user, never to the model"
    text instructions "reaches the writer verbatim"
  }
  CONVERSATIONS {
    uuid id PK
    string title "AI-generated on the first turn"
    uuid project_id FK "NULL = not in a project"
    text note_content "the evolving notes document — never holds slides"
    text draft_transcript "autosaved mid-recording, cleared on send"
    timestamp created_at
    timestamp updated_at
  }
  MESSAGES {
    uuid id PK
    uuid conversation_id FK
    string role "user | assistant"
    text content
    string filename "audio upload name, or recording.webm for live"
    timestamp created_at
  }
  SLIDE_DECKS {
    uuid id PK
    uuid conversation_id FK
    string filename
    int page_count
    bytea pdf "kept, deferred — pages render from it on demand"
  }
  SLIDES {
    uuid id PK
    uuid deck_id FK "NULL only for slides from before decks were kept"
    int position "order across decks"
    int page_number "page in the PDF"
    bool included "in the notes, or just kept in the deck"
    bytea thumbnail "every page, from upload"
    text text "every page, from upload"
    bytea image "full size — only while included"
    text anchor_text "the notes line this slide follows"
    text anchor_heading "nearest heading above that line"
    int after_line "cache: anchor_text's line in the current notes"
  }
  USER_PROFILES {
    uuid id PK
    string name "compiled in; usable in chat, never in the notes"
    jsonb fields "occupation, level, purpose, emphasize, instructions"
    text compiled_prompt "PRIVATE — never returned by the API"
    timestamp compile_failed_at "NULL unless a compile failed"
    timestamp updated_at
  }
```

`USER_PROFILES` is a single global row. Deleting a project deletes its conversations, and a
conversation's messages, decks and slides go with it — the foreign keys all cascade.

Everything the model is told is a constant in `services/notes_graph.py`, apart from the
compiled profile (generated per user, so it lives in the database).

---

## 3. One turn, end to end

The path every input takes, whatever form it started in. Each step is expanded in the page
named beside it.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant CL as Client
  participant API as POST /messages
  participant STT as Deepgram
  participant G as generate_response
  participant LLM as OpenAI
  participant DB as Postgres

  alt live recording
    U->>CL: speak
    CL->>STT: audio via /ws/transcribe
    STT-->>CL: live transcript
    CL->>API: transcript + filename=recording.webm
  else audio file
    U->>CL: attach a file
    CL->>API: the file
    API->>STT: transcribe_audio
    STT-->>API: transcript
  else typed
    U->>CL: type
    CL->>API: transcript
  end
  API->>DB: save the user message
  API->>G: input, history, current notes
  G->>LLM: classify (cheap model)
  alt the notes should change
    G->>LLM: write_notes (writing model)
  else just a question
    G->>LLM: answer_chat
  end
  LLM-->>G: reply, and maybe new notes
  G-->>API: TurnResult
  API->>DB: save the reply, the notes, the title
  Note over API: only if the notes changed: re-anchor any slides
  API-->>CL: the turn, with slides injected into the notes
```

The model never hears audio — only the transcript text. Recording and uploading:
[Transcription](docs/transcription/README.md). The turn itself and why a failure is safe:
[Conversations](docs/conversations/README.md). The two-step model call:
[Notes generation](docs/notes-generation/README.md). Slides re-anchoring:
[Slides](docs/slides/README.md).

---

## 4. Feature map

| Feature | The flow in a line | Detail |
| --- | --- | --- |
| Conversations | A turn saves your message first and removes it again if generation fails; the notes change only when the router says so | [docs/conversations](docs/conversations/README.md) |
| Transcription | `MediaRecorder` chunks → `/ws/transcribe` → Deepgram → a live transcript; or a file → `transcribe_audio` | [docs/transcription](docs/transcription/README.md) |
| Notes generation | `classify → write_notes \| answer_chat`; the router cannot write notes and never sees personalization | [docs/notes-generation](docs/notes-generation/README.md) |
| Personal profile | Answers are committed, then compiled into a private description; Instructions go through verbatim | [docs/profile](docs/profile/README.md) |
| Projects | A folder of conversations whose Instructions reach the writer; deleting one cascades | [docs/projects](docs/projects/README.md) |
| Slides | Keep the whole PDF; tick pages; only the difference is rendered and placed; unplaced slides stay hidden | [docs/slides](docs/slides/README.md) |
| Rendering | `normalizeMath → gfm/math → raw → sanitize → katex`; Mermaid falls back to source | [docs/rendering](docs/rendering/README.md) |
| Chat interface | The composer, the menus, message boxes, collapse and fade | [docs/chat-ui](docs/chat-ui/README.md) |
| Layout | The chat never drops below 360 px: notes shrink, then the sidebar becomes a drawer | [docs/layout](docs/layout/README.md) |
| Testing | Five layers, two stacks, one model stub | [docs/testing](docs/testing/README.md) |

---

## 5. Where state lives

Knowing where a piece of state lives is most of knowing where a bug can be.

| State | Lives in | Survives a reload? |
| --- | --- | --- |
| Conversations, messages, notes | Postgres | yes |
| The autosaved draft transcript | Postgres (`draft_transcript`) | yes |
| Kept slide decks and their pages | Postgres | yes |
| The profile, projects | Postgres | yes |
| An in-progress recording (mic, socket, live transcript) | `RecordingProvider`, in memory, above the router | no — hence the draft |
| A first send that is still generating while the page changes | a module-level variable in `lib/first-send.ts` | no |
| Whether the sidebar / notes are collapsed, and the notes' dragged width | `localStorage` (`sidebar-collapsed`, `notes-panel-collapsed`, `notes-panel-width`) | yes |
| Whether a drawer is open | `LayoutProvider`, in memory | no, by design |
| The conversation and project lists in the sidebar | React context, refetched on demand | refetched |

Nothing is stored about the audio itself: only the transcript and a filename.
