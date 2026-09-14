# AI Note Taker

Record a lecture and watch a notes document write itself.

Speech is transcribed live (Deepgram), and every turn an LLM decides whether the
input should change the notes — then rewrites the document if it should. The
notes are a single evolving Markdown file per conversation, not a transcript and
not a chat log: new material gets integrated into the existing structure rather
than appended to it.

React + TanStack Router on the front, FastAPI + Postgres on the back, LangGraph
in the middle. No auth — this is a portfolio build, single user, one profile row.

**[FLOW.md](FLOW.md)** has end-to-end diagrams for every major path, each naming
the real files and functions involved. Start there if you want to understand how
it works; this file is about running it.

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
- **Draft autosave** — the live transcript is persisted every few seconds, so a
  tab crash mid-lecture doesn't lose it.
- **A personal context layer** — a short profile form, compiled by an LLM into
  a *private* description of the reader that rides along on every note/chat
  prompt, plus an **Instructions** box whose text reaches the writer verbatim.
- **Rich rendering** — GFM, LaTeX math via KaTeX, and Mermaid diagrams. The
  model is instructed to draw a diagram when the material describes a process,
  a state machine, a message exchange, or a branching decision.

## Architecture

```text
Browser  ──REST──>  FastAPI  ──>  LangGraph (classify → write_notes | answer_chat)  ──>  OpenAI
   │                   │
   └──WebSocket───>  /ws/transcribe  ──proxy──>  Deepgram
                       │
                     Postgres (conversations, messages, user_profiles)
```

Two LLM calls per turn, on two different models: `ROUTING_LLM_MODEL` answers
"should the notes change?" against a schema with no `note_content` field — so it
*cannot* write notes even if it wants to — and `LLM_MODEL` does the actual
writing. See [FLOW.md §10](FLOW.md#10-routing-whether-to-touch-the-notes-at-all)
for why that split exists.

## Folder structure

```text
AI-Note-Taker/
├── setup.sh              # one-command setup (see below)
├── redeploy.sh           # rebuild + restart the backend after a code change
├── docker-compose.yml    # local dev stack: db + api
├── docker-compose.test.yml # second stack on :8001 with a stubbed model
├── Dockerfile            # the API image
├── .env / .env.example   # shared config, loaded by the server (and by
│                         # docker-compose.yml to fill in ${VARS})
├── FLOW.md               # end-to-end diagrams of every major path
│
├── client/                    # React + TypeScript + Vite frontend
│   ├── src/
│   │   ├── main.tsx           # entry point — boots the TanStack Router instance
│   │   ├── routes/
│   │   │   ├── __root.tsx           # shell: sidebar + RecordingProvider above the outlet
│   │   │   ├── index.tsx            # new-chat page
│   │   │   └── c.$conversationId.tsx # a conversation: chat left, notes panel right
│   │   ├── components/
│   │   │   ├── chat-composer.tsx    # record / attach / type + send
│   │   │   ├── recording-widget.tsx # floating controls when you navigate away mid-record
│   │   │   ├── notes-panel.tsx      # the notes document — resizable, collapsible
│   │   │   ├── markdown.tsx         # shared renderer: GFM + math + raw HTML + mermaid
│   │   │   ├── mermaid-diagram.tsx  # ```mermaid fences → SVG, lazily imported
│   │   │   ├── message-bubble.tsx   # chat turns, with a file chip for uploads
│   │   │   ├── profile-dialog.tsx   # the profile form + Instructions box
│   │   │   ├── sidebar.tsx          # conversation list + profile row
│   │   │   └── ui/                  # shadcn/ui-generated components
│   │   └── lib/
│   │       ├── api.ts               # typed client for every endpoint
│   │       ├── recording-context.tsx # the recording engine — lives above the router
│   │       └── conversations-context.tsx # shared conversation list state
│   ├── e2e/                   # Playwright acceptance tests
│   ├── vite.config.ts         # dev server + build config, "@/" alias, router plugin
│   └── .oxlintrc.json         # linter config (oxlint, not ESLint)
│
└── server/                    # FastAPI backend
    ├── app/
    │   ├── main.py             # creates the app, registers routers, configures logging
    │   ├── config.py           # reads .env into a typed Settings object
    │   ├── db.py               # engine, session, and init_db() schema setup
    │   ├── models/             # SQLAlchemy: Conversation, Message, UserProfile
    │   ├── services/
    │   │   ├── notes_graph.py  # every prompt + the LangGraph state machine
    │   │   └── transcription.py # Deepgram batch STT
    │   └── api/
    │       ├── health.py         # GET /health
    │       ├── conversations.py  # conversations + the send-message turn
    │       ├── live_transcribe.py # WS /ws/transcribe — Deepgram proxy
    │       └── profile.py        # the profile form + Instructions
    ├── pyproject.toml           # Python deps + project metadata
    └── tests/                   # unit / integration / system layers
```

Root-level dotfiles (`Dockerfile`, `docker-compose.yml`, `.env*`, `.gitignore`)
stay at the repo root because the tools that read them only look there by
convention — they can't be relocated without breaking those tools.

## Setup

```bash
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
| `OPENAI_API_KEY` | Note writing, chat replies, profile compile |
| `LLM_MODEL` | `provider:model` for the writing calls |
| `ROUTING_LLM_MODEL` | `provider:model` for the yes/no router — keep this cheap |
| `DATABASE_URL` | SQLAlchemy URL |
| `CORS_ORIGINS` | Comma-separated browser origins |
| `VITE_API_URL` | Where the client looks for the API |

Both model strings go straight to LangChain's `init_chat_model`, so switching
providers is a matter of changing the string and setting the matching key
(`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, …).

### Schema

There's no migration tool. `init_db()` runs at startup: `create_all()` builds
any missing tables, and a short list of additive `ALTER TABLE … ADD COLUMN IF
NOT EXISTS` statements covers columns that landed after the first create.
Deliberate for a build this size — but it means a destructive schema change has
to be handled by hand, or with `./setup.sh --reset`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness + a real database round trip |
| `POST /conversations` | Create — happens eagerly, the moment recording starts |
| `GET /conversations` | Sidebar list |
| `GET /conversations/{id}` | Messages + notes + any autosaved draft |
| `DELETE /conversations/{id}` | Cascades to messages |
| `PATCH /conversations/{id}/draft` | Autosave the in-progress transcript |
| `POST /conversations/{id}/messages` | One turn: audio and/or text in, notes + reply out |
| `WS /ws/transcribe` | Deepgram live-streaming proxy |
| `GET·PUT·DELETE /profile` | The personal context form |

## Tests

Four layers. The first two need nothing but the code; the last two need a
running stack.

| Layer | Where | Needs |
|---|---|---|
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
audio path has no system coverage; the integration layer covers it by stubbing
`transcribe_audio` directly.

A handful of tests are marked expected-to-fail. Those document known bugs and
will fail loudly if someone fixes the underlying defect without updating them.

## Deploy

Push to any branch runs GitHub Actions (`.github/workflows/ci.yml`), in three
jobs: `server` (unit + integration against a `postgres:16` service), `client`
(lint + unit), and `acceptance` (brings up the stubbed stack, then runs the
system and Playwright suites, uploading traces on failure). No deploy step —
no hosting target chosen yet.

The production image builds from the repo-root [`Dockerfile`](Dockerfile).

## Known gaps

- **No auth.** One profile row, one set of conversations, global to whoever
  opens the page.
- **The audio path has no system coverage** — `DEEPGRAM_TRANSCRIPTION_URL` is
  a module constant, so it can't be redirected at a stub the way OpenAI can.
- **No rate limiting**, and nothing caps the size of a typed message. Fine
  locally; not fine on a public host with real API keys.
