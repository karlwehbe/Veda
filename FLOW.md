# Flows

End-to-end diagrams for the major paths through Da Vinci. Each section
names the real files and functions involved, so a diagram can be traced
straight into the code.

- [1. System overview](#1-system-overview)
- [2. Data model](#2-data-model)
- [3. Live recording → notes](#3-live-recording--notes)
- [4. File upload → notes](#4-file-upload--notes)
- [5. Recording details](#5-recording-details)
- [6. Typed message → notes](#6-typed-message--notes)
- [7. Routing: notes vs chat](#7-routing-notes-vs-chat)
- [8. User profile](#8-user-profile)
- [9. Conversation creation & cleanup](#9-conversation-creation--cleanup)
- [10. Rendering the notes document](#10-rendering-the-notes-document)

---

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser["Browser (React + TanStack Router)"]
    UI["Sidebar / routes<br/>index.tsx, c.$conversationId.tsx"]
    RC["RecordingProvider<br/>lib/recording-context.tsx<br/><i>above the router</i>"]
    CC["ChatComposer<br/>components/chat-composer.tsx"]
    API["api client<br/>lib/api.ts"]
  end

  subgraph Server["FastAPI (server/app)"]
    CONV["/conversations<br/>api/conversations.py"]
    WS["/ws/transcribe<br/>api/live_transcribe.py"]
    PR["/profile<br/>api/profile.py"]
    GRAPH["notes_graph.py<br/>LangGraph: classify → notes/chat"]
    TR["transcription.py<br/>batch STT"]
  end

  DB[("Postgres<br/>conversations, messages,<br/>user_profiles")]
  DG["Deepgram<br/>live + batch STT"]
  LLM["OpenAI<br/>via init_chat_model<br/><i>two models: LLM_MODEL + ROUTING_LLM_MODEL</i>"]

  UI --> CC
  RC -.->|shared recording state| CC
  CC --> API
  API -->|REST| CONV
  API -->|REST| PR
  RC -->|WebSocket audio| WS
  WS <-->|proxied stream| DG
  CONV --> TR --> DG
  CONV --> GRAPH --> LLM
  PR --> GRAPH
  CONV --> DB
  PR --> DB
  GRAPH -->|"reads compiled_prompt"| DB
```

The Deepgram API key never reaches the browser — `/ws/transcribe` proxies the
live stream server-side (`live_transcribe.py`).

---

## 2. Data model

```mermaid
erDiagram
  CONVERSATIONS ||--o{ MESSAGES : has
  CONVERSATIONS {
    uuid id PK
    string title "AI-generated on first turn"
    text note_content "the evolving notes document"
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
  USER_PROFILES {
    uuid id PK
    string name "compiled in; usable in chat, never in the notes"
    jsonb fields "occupation, level, purpose, emphasize, instructions"
    text compiled_prompt "PRIVATE — never returned by the API"
    timestamp compile_failed_at "NULL unless a compile failed"
    timestamp updated_at
  }
```

`USER_PROFILES` is a single global row (no auth in this build). Two fields reach
the model differently:

- **`compiled_prompt`** — LLM-written third-person description of the user.
  Private: pasted into prompts, never returned by the API.
- **`fields.instructions`** — the user's own text, passed to the writer
  **verbatim** (skips the compiler).

Everything else the model is told lives as constants in
`services/notes_graph.py`.

---

## 3. Live recording → notes

`MediaRecorder` emits audio chunks every 250ms. Those chunks stream through
`/ws/transcribe` to Deepgram so a transcript appears while you speak. On send,
that transcript is what becomes the user message and what the LLM reads.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant RC as RecordingContext
  participant DG as Deepgram live
  participant API as /conversations
  participant G as notes_graph
  participant LLM as OpenAI

  U->>RC: start recording
  RC->>DG: WebSocket chunks via /ws/transcribe
  DG-->>RC: live transcript
  U->>RC: send
  RC->>API: POST /messages (transcript + filename)
  Note over API: no audio file — skip batch STT
  API->>G: generate_response(transcript)
  G->>LLM: classify then write_notes or answer_chat
  LLM-->>G: chat_reply + maybe notes
  G-->>API: TurnResult
  API-->>U: MessageTurn
```

The LLM never hears the audio — only the transcript string. Live send posts
`transcript` plus `filename=recording.webm` (metadata only, no bytes). Batch
Deepgram (for when there is no live text) is the
[file upload](#4-file-upload--notes) path.

Details that used to live in this diagram (eager conversation create, draft
autosave, silence delete, pause) are in [§5](#5-recording-details). How the
graph chooses notes vs chat is in [§7](#7-routing-notes-vs-chat).

---

## 4. File upload → notes

No live transcript — the attached file **is** the blob. The server must
transcribe it.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant CC as ChatComposer
  participant API as /conversations
  participant TR as transcription.py
  participant DG as Deepgram REST
  participant G as notes_graph
  participant LLM as OpenAI

  U->>CC: attach audio → send
  CC->>API: POST /messages (file, no transcript)
  API->>TR: transcribe_audio(bytes)
  TR->>DG: POST /v1/listen
  DG-->>API: transcript
  API->>G: generate_response(transcript)
  G->>LLM: classify then write_notes or answer_chat
  LLM-->>G: chat_reply + maybe notes
  G-->>API: TurnResult
  API-->>CC: MessageTurn
```

Chat shows a **file chip** (real filename). Live recordings store
`filename=recording.webm` as metadata only (no audio upload) —
`isFileAttachment()` in `message-bubble.tsx` tells them apart. Audio bytes
are not persisted either way; only transcript + filename are.

---

## 5. Recording details

Extras around the live path in §3 — lifecycle, navigation, and crash safety.

### Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Recording: record (stream + socket ready)
  Recording --> Paused: pause
  Paused --> Recording: resume
  Recording --> Idle: send / discard
  Paused --> Idle: send / discard
```

Pause does **not** split the recording — the same MediaRecorder session
keeps streaming chunks to Deepgram.
Discard (or silence on send) deletes the conversation only if it was created
just for that recording and never successfully sent.

### Survives navigation

`RecordingProvider` sits **above** the router, so changing pages does not stop
the mic.

```mermaid
flowchart LR
  R["Recording in progress"] --> Q{"viewing that conversation?"}
  Q -->|yes| INLINE["ChatComposer: transcript, pause, send"]
  Q -->|no| WIDGET["RecordingWidget in sidebar"]
  WIDGET -->|click| INLINE
```

### Draft autosave

Final Deepgram segments (and pause) `PATCH /{id}/draft`. After a crash or
reload, `GET /conversations/{id}` restores `draft_transcript` into the
composer. A successful send clears it. Guards stop late WebSocket finals from
resurrecting a discarded draft (`allowDraftSaveRef`, clear `onmessage` before
close).

---

## 6. Typed message → notes

No audio — only the text form field.

```mermaid
flowchart LR
  A["User types + send"] --> B["POST /messages<br/>(transcript only)"]
  B --> C["generate_response()"]
  C --> D{"update notes?"}
  D -->|yes| E["notes edited"]
  D -->|no| F["chat reply only"]
  E --> G["MessageTurn"]
  F --> G
```

---

## 7. Routing: notes vs chat

Every turn is a **two-step** LangGraph: classify first, then either write notes
or answer in chat.

```mermaid
flowchart TD
  IN["transcript / typed text"] --> C["classify<br/>→ RouteDecision"]
  C --> Q{"update_notes?"}
  Q -->|true| N{"notes empty?"}
  N -->|yes| WN["write_notes · starting"]
  N -->|no| W["write_notes · extending"]
  Q -->|false| A["answer_chat"]
  WN --> S["notes_updated = true"]
  W --> S
  A --> U["notes_updated = false"]
```

**Why two calls.** The router schema has no `note_content` field, so it
*cannot* rewrite the document. One call asked to “return the full notes”
tended to always return one — filler like `thanks` used to trash the doc.

`conversations.py` only saves notes when `notes_updated` is true.

### What reaches each prompt

```mermaid
flowchart LR
  BASE["DEFAULT_BASE_INSTRUCTIONS"] --> R["routing<br/>ROUTING_LLM_MODEL"]
  BASE --> N["notes<br/>LLM_MODEL"]
  BASE --> C["chat<br/>LLM_MODEL"]
  PROF["compiled_prompt"] -.-> N
  PROF -.-> C
  INST["fields.instructions"] -.-> N
  INST -.-> C
```

The **router** gets neither profile nor instructions — whether notes should
change is independent of who the user is. Both personalization blocks reach
notes *and* chat. Transcript / notes / history are treated as **data** under
a shared trust-boundary rule in `DEFAULT_BASE_INSTRUCTIONS` (prompt hygiene,
not hard enforcement).

---

## 8. User profile

Form answers are compiled into a private description; Instructions stay as the
user typed them.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant PR as /profile
  participant G as notes_graph
  participant DB as Postgres

  U->>PR: PUT name + fields
  PR->>DB: COMMIT answers first
  alt answers changed
    PR->>G: compile_profile(...)
    G-->>PR: description or failure
    PR->>DB: compiled_prompt / compile_failed_at
  end
  PR-->>U: 200 with name + fields only<br/>(never compiled_prompt)
```

| | Compiled description | Instructions |
|---|---|---|
| Author | LLM from form answers | user |
| Visible | no | yes |
| To the writer | compiled prose | verbatim |
| On compile failure | omit personal layer; notes still generate | unaffected |

If answers exist but `compiled_prompt` is null, the next note job **lazy-retries**
compilation once, then continues without personalization rather than failing
the turn.

---

## 9. Conversation creation & cleanup

Recording needs a conversation id for drafts, so create is **eager** on
record. Typed/upload create **lazily** at send.

```mermaid
flowchart TD
  START(["User on /"]) --> ACT{"action"}
  ACT -->|record| EAGER["POST /conversations now"]
  ACT -->|type / attach + send| LAZY["create during send"]
  EAGER --> OUT{"end of recording"}
  OUT -->|send with speech| KEEP["kept · AI title on first turn"]
  OUT -->|silence / discard| DEL["delete throwaway conversation"]
  LAZY --> KEEP
```

Deleting a conversation always stops any attached recording first.

---

## 10. Rendering the notes document

Model Markdown is untrusted input. Notes panel and assistant chat share one
`<Markdown>` component (`components/markdown.tsx`).

```mermaid
flowchart TD
  SRC["Markdown from the model"] --> NM["normalizeMath()"]
  NM --> RG["remark-gfm + remark-math"]
  RG --> RAW["rehype-raw"]
  RAW --> SAN["rehype-sanitize"]
  SAN --> KTX["rehype-katex"]
  KTX --> OUT["React"]
  OUT --> PRE{"mermaid fence?"}
  PRE -->|yes| MD["MermaidDiagram"]
  PRE -->|no| CODE["code block"]
```

Order matters: **raw → sanitize → katex** (KaTeX injects classes sanitize
would strip). Mermaid is intercepted on `<pre>`, loaded dynamically, and
falls back to source on parse failure so a bad diagram never blanks the
notes.
