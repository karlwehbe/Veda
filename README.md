# Veda

https://github.com/user-attachments/assets/f66330b3-43a9-4ec4-86c0-4d80bcdea600

Record a lecture and watch a notes document write itself.

Speech is transcribed live, and on every message an AI decides whether it should change the notes, then changes only
what it should. The notes are one evolving document per conversation, not a transcript and not a chat log: new
material is folded into the existing structure. A chat sits beside the notes for questions and requests, and the
lecture's slides land where they belong.

> **The source code is private.** This repository is a showcase: the demo and the documentation.

## Documentation

| | |
| --- | --- |
| **[DESIGN.md](DESIGN.md)** | Why it is built this way: the decisions and their alternatives, and what breaks at scale |

## What it does

- **Live recording** from the microphone or the computer's audio, streamed to Soniox through the server (the key
  never reaches the browser), with Grok taking over when Soniox is down. The transcript appears as you speak, keeps
  recording across pages, and survives a dropped connection or a crashed tab: the audio is kept on the device and the
  missing part is filled in. A phone records in 3 minute pieces instead, turned into text in the background and shown
  at Stop.
- **Files** (uploads, the gaps of a live recording, a phone's pieces) go to Grok, with Soniox as the backup.
- **Audio and video uploads**, up to 500 MB and 6 hours, compressed and cut at quiet moments before transcription.
- **Typed messages**: ask a question, or tell it to add a section.
- **A router decides whether to touch the notes.** A cheap model answers one yes-or-no question first, so "thanks" or
  "what does X mean?" can't rewrite the document; only then does the writing model run.
- **Small edits, never a retyped document.** The notes are blocks with stable keys; the writer names the blocks to
  change, and code checks every edit before saving.
- **Versions**: every change is one, and you can go back to any of the last 50.
- **Block actions**: select text in the notes and Simplify, Expand, Add an example, Regenerate, or write your own
  instruction for just those paragraphs.
- **Slides**: upload a PDF (or PowerPoint, OpenDocument, Keynote), pick the pages in the browser, and the AI places each
  under the part of the notes it belongs to. Or drag them yourself, side by side if you like.
- **Check these words**: terms the AI wasn't sure it heard are marked, and fixing one fixes it everywhere.
- **Projects**: folders of conversations with their own Instructions, and a memory of the course's terms.
- **Personal context**: a short profile, your own Instructions, and note-style habits Veda learns from how you use it,
  all visible and editable in Settings.
- **Export** as Markdown, a zip with the slide pictures (opens as is in Obsidian), or a PDF.
- **Rendering**: Markdown with tables, LaTeX maths (KaTeX) and Mermaid diagrams, with repairs for what models get wrong.
- **An adaptive layout**: the sidebar and notes sit beside the chat on a wide window and become drawers on a narrow
  one; light and dark themes.

## Architecture

```text
Browser (React)  ──HTTP──>  FastAPI  ──>  LangGraph: router → notes writer | chat reply  ──>  OpenAI
     │                        │
     └──WebSocket──>  live audio relay  ──>  Soniox live (Grok as the backup)
                              │
                              ├──>  Grok / Soniox for files (uploads, gaps, a phone's pieces)
                              ├──>  Postgres
                              └──>  Object storage for slide files
```

Each message makes at least two model calls, on two models. A small routing model answers "should the notes change?"
against a schema with no notes field, so it *cannot* write notes even if it wants to. Only then does a larger model
write, as edits to named blocks that code checks before saving. [DESIGN.md](DESIGN.md#4-one-turn-from-message-to-saved-notes)
explains why.

React and TanStack Router in the browser; FastAPI, Postgres and LangGraph on the server; object storage for slide
files.
