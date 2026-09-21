# Veda documentation

The [repo README](../README.md) is about running Veda. These pages are about how it
works: one page per feature, each with the same six parts, so once you have read
one you know where to find things in the rest.

| Feature | What it covers |
| --- | --- |
| [Conversations](conversations/README.md) | A conversation and its messages; the send-message turn; drafts; titles; eager vs lazy creation; cleanup |
| [Transcription](transcription/README.md) | Live recording over the Deepgram proxy, audio-file upload, draft autosave, the floating recording widget |
| [Notes generation](notes-generation/README.md) | The LangGraph turn: the router, the writer, the chat reply, prompt assembly, the trust boundary |
| [Personal profile](profile/README.md) | The profile form, the private compiled description, Instructions |
| [Projects](projects/README.md) | Folders of conversations, and the project Instructions that reach the writer |
| [Slides](slides/README.md) | Upload a PDF once, tick the pages that belong in the notes, and where each one lands |
| [Rendering](rendering/README.md) | Markdown, math and Mermaid in the notes and chat; repairing what models get wrong |
| [Chat interface](chat-ui/README.md) | The composer, the "+" menu, message boxes, collapsing long messages, fades |
| [Layout](layout/README.md) | Sidebar and notes beside the chat or over it; the rule that keeps the chat readable |
| [Testing](testing/README.md) | The five test layers, the two stacks, the model stub, CI |

For a single picture of how the pieces connect, start with [FLOW.md](../FLOW.md).

## How each page is laid out

1. **What it does** — in plain language, from the user's side.
2. **Where the code lives** — a table of files and what each is for.
3. **Flows** — diagrams that name the real functions, so one can be traced into the code.
4. **Data and API** — the tables and endpoints involved, and the rules they keep.
5. **Design decisions** — why it is built this way, where that isn't obvious from the code.
6. **Tests** — what the tests look like (a real one, quoted), a table of what each group
   proves, the command to run just that feature's tests, and what they do **not** cover.

The "Not covered" lists are deliberate. A test suite is only as useful as your
knowledge of where it stops.

Test counts are left out of these pages on purpose: they go stale the moment a test is
added. Tests are described by the group they belong to, which is stable and easy to
check with the command on each page.
