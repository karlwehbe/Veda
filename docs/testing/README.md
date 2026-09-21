# Testing

How Veda is tested as a whole. Each [feature page](../README.md) has its own
**Tests** section saying what that feature's tests cover; this page is the shared
picture: the layers, how to run them, the model stub, and CI.

## The five layers

| Layer | Where | What it is | Needs |
| --- | --- | --- | --- |
| Unit (server) | `server/tests/unit/` | Pure functions and prompt assembly. No database, no network. | nothing |
| Unit (client) | `client/src/**/*.test.ts` | Pure client logic: math repair, fade and layout arithmetic, selection helpers. No DOM. | nothing |
| Integration | `server/tests/integration/` | The real FastAPI app over `TestClient`, against a real Postgres. Only the model and Deepgram are stubbed. | Postgres |
| System | `server/tests/system/` | Real HTTP against the running test stack, model stubbed at the network edge. | the test stack |
| Acceptance | `client/e2e/` | Playwright driving a real browser against the real client and the test stack. | the test stack + a browser |

```bash
cd server && pytest tests/unit tests/integration -q     # unit + integration
cd server && pytest tests/system -q                      # system (stack must be up)
cd client && npm test                                    # client unit (vitest)
cd client && npm run test:e2e                            # acceptance (stack must be up)
```

Each layer answers a different question. **Unit** tests say a rule holds. **Integration**
tests say the API and the database keep their promises together — the layer where a
failure loses someone's lecture. **System** tests say the stack is wired the way it is
meant to be (for example that the model really is being reached through the stub).
**Acceptance** tests say a person can actually do the thing in a browser.

## Why integration tests need a real Postgres

The models use `JSONB` and the PostgreSQL `UUID` type, so SQLite cannot stand in.
`server/tests/conftest.py` connects to `DATABASE_URL_TEST` — by default a separate
`ai_note_taker_test` database on the local Postgres — creates it if missing, creates the
tables, and **truncates every table before each test** so tests never see each other's
rows.

The guard rail: it refuses to run at all unless the database name contains `test`, so a
mistyped URL cannot truncate real data.

## The two stacks

| | Dev stack | Test stack |
| --- | --- | --- |
| API | `localhost:8000` | `localhost:8001` |
| Model | real OpenAI, real keys | a stub |
| Database | `ai_note_taker` — your real notes | `ai_note_taker_system` — throwaway |
| Defined in | `docker-compose.yml` | `docker-compose.test.yml` |

The test stack is layered *on top of* the dev one and adds two **new services**
(`api-test`, `llm-stub`) rather than overriding `api`. That is deliberate: a Compose file
can hold only one container per service name, so overriding `api` would replace your dev
API instead of running beside it — and the browser app on :8000 would silently end up on
the test database. With separate services, both run at once and your dev data is never
touched. Playwright is pointed at `:8001` (never `:8000`) for the same reason.

```bash
docker compose exec -T db psql -U postgres -c \
  "SELECT 'CREATE DATABASE ai_note_taker_system' WHERE NOT EXISTS \
   (SELECT FROM pg_database WHERE datname='ai_note_taker_system')\gexec"
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build api-test llm-stub
```

If the stack is not reachable, the whole system layer **skips** rather than fails — an
absent environment is not a broken build.

## The model stub

`server/tests/system/llm_stub.py` stands in for OpenAI. The app reaches models through
LangChain's `with_structured_output`, which sends the target schema as a tool definition
and expects a tool call back. So the stub is generic: it reads the requested schema name
off each incoming request and answers with canned arguments that match it.

| Schema the app asks for | The stub answers |
| --- | --- |
| `RouteDecision` | `update_notes: true` |
| `NotesUpdate` | a fixed notes document (a bullet list, display math, and a matrix) plus a chat reply and a title |
| `ChatReply` | a fixed reply |
| `CompiledProfile` | a fixed description |
| `SlidePlacements` | places slides 1–4 after line 4; says nothing about later ones, so a second deck's pages have no spot |

An unknown schema returns a loud 500 rather than something plausible: it means the app
changed shape and the stub is stale.

The stub also **records every request** and serves them at `/__stub/requests`. That is
how a test can assert on what the stack actually sent the model — that the router ran
before the writer, that the transcript reached it, that nothing reached a real provider.

Two things follow from this:

- Nothing costs money and nothing flakes on model sampling.
- Deepgram is **not** stubbed. Its URLs are module constants (`DEEPGRAM_LIVE_URL`,
  `DEEPGRAM_TRANSCRIPTION_URL`), not settings, so they cannot be redirected the way
  `OPENAI_BASE_URL` can. See [Transcription](../transcription/README.md#tests).

## Expected failures

Tests marked `xfail(strict=True)` document a known bug. `strict` means that if someone
fixes the bug without updating the test, the suite **fails** — so a documented bug cannot
quietly stop being documented. There is one today: a failed generation deletes the user's
message but does not restore the autosaved draft (see
[Conversations](../conversations/README.md#tests)).

## Conventions the suites follow

- **Integration tests replace only the model.** They patch `generate_response` (and, for
  slides, `place_slides`) where the endpoint *uses* it, so routing, SQLAlchemy, real
  commits, multipart uploads and the deferred columns are all real.
- **Acceptance tests seed through the API**, not the UI, when the UI isn't what is being
  tested — for example creating a conversation and posting a message to it.
- **Every test cleans up after itself by id.** Acceptance tests delete only the
  conversations they created, never the whole table, because the suite runs against
  whatever stack is up.
- **Layout assertions retry.** Anything that depends on a resize or on fonts loading uses
  a polling assertion (`expect.poll`) rather than a one-shot measurement. Several
  otherwise-good tests were flaky until they did.
- **Error text is product copy.** The client shows the API's `detail` to people exactly as
  written, so it has to read like a real product: a sentence, nothing about keys, providers,
  status codes or deploys. Four tests hold that line, and `tests/copy_rules.py` is the shared
  definition: `unit/test_error_messages.py` scans **every** user-facing string in the server's
  source (so a new message written in developer-speak fails the build) and checks that a
  missing configuration says "not available right now" and never which key;
  `integration/test_error_messages_api.py` triggers the real errors over HTTP;
  `client/src/lib/api.test.ts` covers how error responses become text (no status codes, no
  `[object Object]` from a validation error); and "Error messages" in `e2e/messages.spec.ts`
  shows what lands on screen.
- **One worker.** Playwright runs with `workers: 1`: the suite shares a backend and would
  race on the conversation list and the single profile row.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, and cancels an older run
for the same branch when a new commit lands. Three jobs:

| Job | Steps |
| --- | --- |
| `server` | A `postgres:16` service; `pip install -e ".[dev]"`; `pytest tests/unit tests/integration -q` |
| `client` | `npm ci`; `npm run lint`; `npm test` |
| `acceptance` | Brings up the stubbed stack (`db`, then `llm-stub` and `api-test`), waits for `:8001/health`; runs `pytest tests/system -q`; installs Chromium and runs `npm run test:e2e`; uploads Playwright traces if anything failed |

There is no deploy step — no hosting target has been chosen. The production image builds
from the repo-root `Dockerfile`.

## Running one feature's tests

Each feature page ends with the exact commands for its own tests. The general forms:

```bash
cd server && pytest tests/integration/test_projects_api.py -q          # one file
cd server && pytest tests/unit/test_prompts.py -k "Router" -q          # one group, by name
cd client && npx vitest run src/lib/layout-math.test.ts                # one client unit file
cd client && npx playwright test slides.spec.ts -g "removing a page"   # one e2e test, by title
```
