# Veda

https://github.com/user-attachments/assets/f66330b3-43a9-4ec4-86c0-4d80bcdea600

Record a lecture and watch a notes document write itself.

Speech is transcribed live (Deepgram), and every turn an LLM decides whether the
input should change the notes — then rewrites the document if it should. The
notes are a single evolving Markdown file per conversation, not a transcript and
not a chat log: new material gets integrated into the existing structure rather
than appended to it. Upload the lecture's slides and each one is placed in the



notes where it belongs.

React + TanStack Router on the front, FastAPI + Postgres on the back, LangGraph
in the middle. No auth — this is a portfolio build, single user, one profile row.

```bash
git clone https://github.com/karlwehbe/Veda.git
cd Veda
./setup.sh --start
```

This page is about running it. To understand how it works, start with
**[FLOW.md](FLOW.md)** (the overview) and the **[feature documentation](docs/README.md)**
— one page per feature, each with its flows, its design decisions, and what its tests
cover.

## What it does

- **Live recording** — mic or system audio, streamed to Deepgram over a
  server-side WebSocket proxy (the API key never reaches the browser). The
  transcript appears as you speak, and keeps recording across page navigation.
- **Audio upload** — no live transcript, so the server transcribes via
  Deepgram's batch API instead.
- **Typed messages** — ask a question, or tell it to add a section.
- **A router decides whether to touch the notes.** A cheap model answers one
  yes/no question first, so `thanks` or `what does X mean?` can't rewrite the
  document. Only then does the expensive call run.
- **Lecture slides** — once a conversation has notes, upload the deck as a
  PDF. It is kept whole: the slides dialog shows every page with a check on the
  ones in the notes. Tick a page to add just that page, untick to remove just
  that page (it stays in the deck), and add or remove more later without
  uploading again.
- **Projects** — folders of conversations (a course, a research topic), each
  with its own Instructions that reach the writer on every turn.
- **A personal context layer** — a short profile form, compiled by an LLM into
  a *private* description of the reader that rides along on every note/chat
  prompt, plus an **Instructions** box whose text reaches the writer verbatim.
- **Draft autosave** — the live transcript is persisted every few seconds, so a
  tab crash mid-lecture doesn't lose it.
- **Rich rendering** — GFM, LaTeX math via KaTeX, and Mermaid diagrams. The
  model is instructed to draw a diagram when the material describes a process,
  a state machine, a message exchange, or a branching decision.
- **A chat interface that stays readable** — long messages collapse behind a
  "Show more" with a soft fade, and an uploaded audio file and its transcript
  are one box.
- **An adaptive layout** — the sidebar and notes sit beside the chat on a wide
  window and become drawers over it on a narrow one, so the chat never drops
  below a readable width.

## Documentation

| | |
| --- | --- |
| [FLOW.md](FLOW.md) | The overview: system, data model, one turn end to end, where state lives |
| [Conversations](docs/conversations/README.md) | A conversation and its messages; the send-message turn; drafts; titles |
| [Transcription](docs/transcription/README.md) | Live recording, audio upload, draft autosave, the recording widget |
| [Notes generation](docs/notes-generation/README.md) | The router, the writer, prompt assembly, the trust boundary |
| [Personal profile](docs/profile/README.md) | The profile form, the private compiled description, Instructions |
| [Projects](docs/projects/README.md) | Folders of conversations and project Instructions |
| [Slides](docs/slides/README.md) | Keeping a PDF, ticking pages, and where each slide lands |
| [Rendering](docs/rendering/README.md) | Markdown, math and Mermaid; repairing what models get wrong |
| [Chat interface](docs/chat-ui/README.md) | The composer, the "+" menu, message boxes, collapse and fade |
| [Layout](docs/layout/README.md) | Drawers, the adaptive rule, the 360 px chat minimum |
| [Testing](docs/testing/README.md) | The five test layers, the two stacks, the model stub, CI |

## Architecture

```text
Browser  ──REST──>  FastAPI  ──>  LangGraph (classify → write_notes | answer_chat)  ──>  OpenAI
   │                   │
   └──WebSocket───>  /ws/transcribe  ──proxy──>  Deepgram
                       │
                     Postgres (conversations, messages, projects,
                               slide_decks, slides, user_profiles)
```

Two LLM calls per turn, on two different models: `ROUTING_LLM_MODEL` answers
"should the notes change?" against a schema with no `note_content` field — so it
*cannot* write notes even if it wants to — and `LLM_MODEL` does the actual
writing. See [Notes generation](docs/notes-generation/README.md#a-turn-is-two-steps)
for why that split exists.

## Folder structure

```text
Veda/
├── setup.sh                # one-command setup (see below)
├── redeploy.sh             # rebuild + restart the backend after a code change
├── docker-compose.yml      # local dev stack: db + api
├── docker-compose.test.yml # second stack on :8001 with a stubbed model
├── Dockerfile              # the API image
├── .env / .env.example     # shared config, loaded by the server (and by
│                           # docker-compose.yml to fill in ${VARS})
├── FLOW.md                 # the overview: system, data model, one turn, state
├── docs/                   # one page per feature — flows, decisions, tests
│   ├── README.md           # index
│   ├── conversations/  transcription/  notes-generation/  profile/
│   ├── projects/  slides/  rendering/  chat-ui/  layout/
│   └── testing/            # the five layers, the two stacks, CI
│
├── client/                      # React + TypeScript + Vite frontend
│   ├── src/
│   │   ├── main.tsx             # entry point — boots the TanStack Router instance
│   │   ├── routes/
│   │   │   ├── __root.tsx             # shell: providers, sidebar, the outlet
│   │   │   ├── index.tsx              # new-chat page
│   │   │   ├── c.$conversationId.tsx  # a conversation: chat, notes panel
│   │   │   └── p.$projectId.tsx       # a project: its conversations
│   │   ├── components/
│   │   │   ├── chat-composer.tsx      # record / attach / type + send; the "+" menu
│   │   │   ├── message-bubble.tsx     # your message boxes, the assistant's prose
│   │   │   ├── notes-panel.tsx        # the notes — docked (resizable) or a drawer
│   │   │   ├── sidebar.tsx            # conversations, projects, profile row
│   │   │   ├── sidebar-toggle.tsx     # buttons that open the drawers
│   │   │   ├── slides-dialog.tsx      # keep a PDF, tick pages, manage decks
│   │   │   ├── slide-grid.tsx         # the selectable thumbnail grid
│   │   │   ├── markdown.tsx           # GFM + math + raw HTML + mermaid, and the math repairs
│   │   │   ├── mermaid-diagram.tsx    # ```mermaid fences → SVG, lazily imported
│   │   │   ├── recording-widget.tsx   # controls when you navigate away mid-record
│   │   │   ├── profile-dialog.tsx     # the profile form + Instructions
│   │   │   ├── project-form-dialog.tsx, project-menu.tsx
│   │   │   ├── confirm-dialog.tsx, generating-indicator.tsx
│   │   │   └── ui/                    # shadcn/ui-generated components
│   │   └── lib/
│   │       ├── api.ts                 # typed client for every endpoint
│   │       ├── recording-context.tsx  # the recording engine — above the router
│   │       ├── layout-context.tsx     # window width, drawers, panel preferences
│   │       ├── layout-math.ts         # which panels are docked, and how wide
│   │       ├── fade.ts                # the soft fade where text is clipped
│   │       ├── slides.ts              # slide-image and selection helpers
│   │       ├── conversations-context.tsx, use-conversations.ts
│   │       ├── projects-context.tsx, use-projects.ts
│   │       ├── first-send.ts, use-stream-reveal.ts, utils.ts
│   │       └── *.test.ts              # client unit tests (vitest)
│   ├── e2e/                     # Playwright acceptance tests + a fixture PDF
│   ├── vite.config.ts           # dev server + build config, "@/" alias, router plugin
│   └── .oxlintrc.json           # linter config (oxlint, not ESLint)
│
└── server/                      # FastAPI backend
    ├── app/
    │   ├── main.py              # creates the app, registers routers, configures logging
    │   ├── config.py            # reads .env into a typed Settings object
    │   ├── db.py                # engine, session, and init_db() schema setup
    │   ├── models/              # Conversation, Message, Project, Slide, SlideDeck, UserProfile
    │   ├── services/
    │   │   ├── notes_graph.py   # every prompt + the LangGraph state machine
    │   │   ├── slides.py        # reading decks, rendering pages, placing slides in the notes
    │   │   └── transcription.py # Deepgram batch STT
    │   └── api/
    │       ├── health.py          # GET /health
    │       ├── conversations.py   # conversations + the send-message turn
    │       ├── projects.py        # projects
    │       ├── slides.py          # decks, pages, images
    │       ├── live_transcribe.py # WS /ws/transcribe — Deepgram proxy
    │       └── profile.py         # the profile form + Instructions
    ├── pyproject.toml           # Python deps + project metadata
    └── tests/                   # unit / integration / system layers
```

Root-level dotfiles (`Dockerfile`, `docker-compose.yml`, `.env*`, `.gitignore`)
stay at the repo root because the tools that read them only look there by
convention — they can't be relocated without breaking those tools.

## Setup

```bash
git clone https://github.com/karlwehbe/Veda.git && cd Veda
./setup.sh          # check prerequisites, write .env, build and start the backend, install client deps
./setup.sh --start  # ...and start the frontend when it's done
./setup.sh --reset  # wipe the database volume first (destroys local data)
```

It's safe to re-run — every step checks the current state before changing
anything, so it doubles as a "get me back to a working state" script. It'll warn
about missing API keys and continue; the app starts fine without them, but
recording and note generation return errors until they're filled in.

### Or by hand

```bash
cp .env.example .env      # then fill in DEEPGRAM_API_KEY and OPENAI_API_KEY
docker compose up --build # db + api
```

```bash
cd client && npm install && npm run dev
```

- Frontend: [localhost:5173](http://localhost:5173)
- API: [localhost:8000](http://localhost:8000) — interactive docs at `/docs`
- Postgres: `localhost:5432` / `postgres` / `postgres` / db `ai_note_taker`

### A note on names

The project is called Veda, but the database (`ai_note_taker`, plus `_test` and
`_system` for the test layers) and the Docker project (`ai-note-taker`) keep their
original names on purpose. Renaming them would orphan an existing database volume.
`docker-compose.yml` pins the project name (`name: ai-note-taker`), so the stack is the
same whatever the folder you cloned into is called — without that, Compose derives the
project name from the folder and a differently named clone would start with an *empty*
database.

### After changing backend code

```bash
./redeploy.sh
```

The `api` service has **no bind mount** — it runs code baked into the image at
build time, so editing a `.py` file changes nothing until the image is rebuilt.
`docker compose restart api` looks like it worked and silently keeps serving the
old code. The script rebuilds, waits for health, and then compares a hash of
`notes_graph.py` inside the container against your working copy, so a cached
layer fails loudly instead of invisibly. It never touches the `db` service and
never passes `-v`, so your data is safe; `./setup.sh --reset` is the only thing
that wipes it.

### Configuration

| Variable | Purpose |
| --- | --- |
| `DEEPGRAM_API_KEY` | Transcription, both live and batch ([console.deepgram.com](https://console.deepgram.com)) |
| `OPENAI_API_KEY` | Note writing, chat replies, profile compile, slide placement |
| `LLM_MODEL` | `provider:model` for the writing calls |
| `ROUTING_LLM_MODEL` | `provider:model` for the yes/no router — keep this cheap |
| `DATABASE_URL` | SQLAlchemy URL |
| `CORS_ORIGINS` | Comma-separated browser origins |
| `VITE_API_URL` | Where the client looks for the API |

Both model strings go to LangChain's `init_chat_model`. **Only the `openai`
provider is wired up today**: the server maps a provider to the setting holding its
key (`_PROVIDER_KEY_FIELDS` in `notes_graph.py`), and `openai` is the only entry, so
any other provider fails with a `503` ("The AI service isn't available right now" — the
provider and the missing key are logged, not shown). Adding one means adding it to
that map and giving `Settings` its key field — see
[Notes generation](docs/notes-generation/README.md#data-and-api).

### Schema

There's no migration tool. `init_db()` runs at startup: `create_all()` builds
any missing tables, and a short list of additive `ALTER TABLE … ADD COLUMN IF
NOT EXISTS` statements covers columns that landed after the first create — the
project link on conversations, the slide-deck columns on slides, and so on. It is
safe to run repeatedly. Deliberate for a build this size — but it means a
destructive schema change has to be handled by hand, or with `./setup.sh --reset`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness + a real database round trip |
| `POST /conversations[?project_id=]` | Create — eagerly when recording starts, or filed in a project |
| `GET /conversations` | Sidebar list |
| `GET /conversations/{id}` | Messages + notes (with slides) + `slide_count` + any autosaved draft |
| `DELETE /conversations/{id}` | Cascades to messages, slides and decks |
| `PATCH /conversations/{id}/draft` | Replace the autosaved transcript wholesale (used only to clear it) |
| `PATCH /conversations/{id}/draft/append` | Autosave the in-progress transcript, one chunk at a time |
| `POST /conversations/{id}/messages` | One turn: audio and/or text in, notes + reply out |
| `WS /ws/transcribe` | Deepgram live-streaming proxy |
| `GET·PUT·DELETE /profile` | The personal context form |
| `POST·GET /projects` | Create a project / list them with conversation counts |
| `GET·PUT·DELETE /projects/{id}` | A project and its conversations / edit it / delete it and its conversations |
| `POST /conversations/{id}/slides/decks` | Keep an uploaded PDF: a thumbnail and the text of every page — nothing goes in the notes |
| `PATCH /conversations/{id}/slides` | Put pages in the notes / take them out (`{add, remove}`); only those pages are rendered and placed |
| `GET /conversations/{id}/slides` | Every page of every deck, and which are in the notes |
| `DELETE /conversations/{id}/slides/decks/{deck_id}` | Forget an uploaded PDF and its pages |
| `GET /slides/{id}/image` · `/thumbnail` | The slide's bytes (immutable, cached forever) |

## Tests

Five layers. The first two need nothing but the code; integration needs
Postgres; the last two need a running stack.

| Layer | Where | Needs |
| --- | --- | --- |
| Unit (server) | `server/tests/unit/` | nothing |
| Unit (client) | `client/src/**/*.test.ts` | nothing |
| Integration | `server/tests/integration/` | Postgres |
| System | `server/tests/system/` | the test stack |
| Acceptance | `client/e2e/` | the test stack + a browser |

```bash
cd server && pytest tests/unit tests/integration -q
cd client && npm test
```

`setup.sh` creates the server venv for you.

### System and acceptance tests

These run against a second stack defined by `docker-compose.test.yml`, which
adds an `api-test` service on **port 8001** and a stub standing in for OpenAI.
It is a separate service rather than an override of `api` on purpose: both
stacks then run side by side, and your dev API on :8000 — with real API keys
and your real notes — is never touched.

```bash
docker compose exec -T db psql -U postgres -c \
  "SELECT 'CREATE DATABASE ai_note_taker_system' WHERE NOT EXISTS \
   (SELECT FROM pg_database WHERE datname='ai_note_taker_system')\gexec"
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build api-test llm-stub

cd server && pytest tests/system -q
cd client && npm run test:e2e
```

The stub reads the schema off each request and answers with canned structured
output, so nothing costs money and nothing flakes on model sampling. Deepgram
is *not* stubbed — its URL is a module constant rather than a setting — so the
audio paths have no system or acceptance coverage at all.

A handful of tests are marked expected-to-fail. Those document known bugs and
will fail loudly if someone fixes the underlying defect without updating them.

What each layer covers for each feature — and what it doesn't — is on that
feature's page under [docs/](docs/README.md); the shared setup is in
[Testing](docs/testing/README.md).

## Deploy

Push to any branch runs GitHub Actions (`.github/workflows/ci.yml`), in three
jobs: `server` (unit + integration against a `postgres:16` service), `client`
(lint + unit), and `acceptance` (brings up the stubbed stack, then runs the
system and Playwright suites, uploading traces on failure). No deploy step —
no hosting target chosen yet.

The production image builds from the repo-root [`Dockerfile`](Dockerfile).
