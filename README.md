# Veda

https://github.com/user-attachments/assets/1b1496bd-8a14-421e-afac-005f8f98bc32

Record a lecture and watch a notes document write itself.

Speech is transcribed live (Deepgram), and every turn an LLM decides whether the
input should change the notes — then rewrites the document if it should. The
notes are a single evolving Markdown file per conversation, not a transcript and
not a chat log: new material gets integrated into the existing structure rather
than appended to it. Upload the lecture's slides and each one is placed in the notes where it belongs.

FastAPI + Postgres, with LangGraph orchestrating the LLM calls.

> **The source code is private.** This repository is a showcase: the demo, the
> README and the design documentation.

To understand how it works, start with
**[FLOW.md](FLOW.md)** (the overview) and the **[feature documentation](docs/README.md)**
— one page per feature, each with its flows and its design decisions.

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
  PDF. It is kept whole: every page is listed, with a check on the
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

## Documentation

| | |
| --- | --- |
| [FLOW.md](FLOW.md) | The overview: system, one turn end to end, where state lives |
| [Conversations](docs/conversations/README.md) | A conversation and its messages; the send-message turn; drafts; titles |
| [Transcription](docs/transcription/README.md) | Live recording, audio upload, draft autosave |
| [Notes generation](docs/notes-generation/README.md) | The router, the writer, prompt assembly, the trust boundary |
| [Personal profile](docs/profile/README.md) | The profile form, the private compiled description, Instructions |
| [Projects](docs/projects/README.md) | Folders of conversations and project Instructions |
| [Slides](docs/slides/README.md) | Keeping a PDF, ticking pages, and where each slide lands |

## Architecture

```text
Client   ──REST──>  FastAPI  ──>  LangGraph (classify → write_notes | answer_chat)  ──>  OpenAI
   │                   │
   └──WebSocket───>  /ws/transcribe  ──proxy──>  Deepgram
                       │
                     Postgres (conversations, notes, projects,
                               slides, profiles)
```

Two LLM calls per turn, on two different models: a small routing model answers
"should the notes change?" against a schema with no `note_content` field — so it
*cannot* write notes even if it wants to — and a larger writing model does the actual
writing. See [Notes generation](docs/notes-generation/README.md#a-turn-is-two-steps)
for why that split exists.

