# Veda documentation

The [repo README](../README.md) is about running Veda. These pages are about how it
works: one page per feature, each with the same six parts, so once you have read
one you know where to find things in the rest.

| Feature | What it covers |
| --- | --- |
| [Conversations](conversations/README.md) | A conversation and its messages; the send-message turn; drafts; titles; eager vs lazy creation; cleanup |
| [Transcription](transcription/README.md) | Live recording over the Deepgram proxy, audio-file upload, draft autosave |
| [Notes generation](notes-generation/README.md) | The LangGraph turn: the router, the writer, the chat reply, prompt assembly, the trust boundary |
| [Personal profile](profile/README.md) | The profile form, the private compiled description, Instructions |
| [Projects](projects/README.md) | Folders of conversations, and the project Instructions that reach the writer |
| [Slides](slides/README.md) | Upload a PDF once, tick the pages that belong in the notes, and where each one lands |

For a single picture of how the pieces connect, start with [FLOW.md](../FLOW.md).

## How each page is laid out

1. **What it does** — in plain language, from the user's side.
2. **Flows** — diagrams of how the pieces interact.
3. **Design decisions** — why it is built this way.
