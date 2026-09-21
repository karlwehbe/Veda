"""A deterministic stand-in for the OpenAI chat completions API.

System tests run the real stack — real containers, real Postgres, real HTTP —
but a real model would make them slow, costly, and non-deterministic. Since
this project's recurring pain *is* model non-determinism, a suite that depends
on it would report noise instead of regressions.

The app talks to OpenAI through langchain's `with_structured_output`, which
sends the target schema as a tool definition and expects a tool call back. So
this stub is generic: it reads the requested tool name off the incoming
request and answers with arguments matching that schema. No test needs to know
the wire format.

Pointed at by OPENAI_BASE_URL — the openai SDK reads it from the environment,
so nothing in app/ changes to run against this.
"""

import json
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="LLM stub")

# Canned arguments per schema. Keys are the Pydantic model names that
# notes_graph passes to with_structured_output.
RESPONSES: dict[str, dict[str, Any]] = {
    "RouteDecision": {
        "update_notes": True,
        "reason": "The input carries substantive lecture content.",
    },
    "NotesUpdate": {
        "note_content": (
            "# Vectors\n\n"
            "- A **vector** has magnitude and direction.\n"
            "- In two dimensions it is written with the unit vectors "
            "$\\hat{i}$ and $\\hat{j}$:\n\n"
            "$$\n\\vec{v} = x\\hat{i} + y\\hat{j}\n$$\n\n"
            # A matrix with rows starting on a letter. This is the shape that
            # the \\ collapse rule used to destroy — the separator became \c
            # and KaTeX rendered the source in red. Kept here so the
            # acceptance layer exercises it in a real browser.
            "- A matrix acts on that vector:\n\n"
            "$$\n"
            "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}"
            "\\begin{bmatrix}x\\\\y\\end{bmatrix}\n"
            "$$\n"
        ),
        "chat_reply": "Started your notes on vectors.",
        "title": "Vectors",
    },
    "ChatReply": {
        "chat_reply": "A vector has magnitude and direction.",
        "title": "Vectors",
    },
    # Slide placement. The stub can't know how many slides it was sent, so it
    # answers for slides 1-4, all "after line 4" (1-based) — the end of the
    # first bullet list in the NotesUpdate document above. Entries for slides
    # that weren't sent are ignored by the app.
    "SlidePlacements": {
        "placements": [{"slide": n, "after_line": 4} for n in range(1, 5)],
    },
    "CompiledProfile": {
        "instructions": "Write for a software engineer with some background in the subject.",
    },
}

# Lets a test assert on what the app actually asked for — that the router ran
# on the cheap model, that history reached it, that the profile did not.
REQUESTS: list[dict[str, Any]] = []


@app.get("/__stub/requests")
def get_requests() -> list[dict[str, Any]]:
    return REQUESTS


@app.delete("/__stub/requests")
def clear_requests() -> dict[str, str]:
    REQUESTS.clear()
    return {"status": "cleared"}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> dict[str, Any]:
    body = await request.json()

    # with_structured_output picks one of two wire formats depending on the
    # model and langchain version: a single tool definition, or a json_schema
    # response_format. Handle both, and answer in whichever was asked for —
    # replying with a tool call to a json_schema request parses as an empty
    # response, which surfaces as a validation error rather than anything
    # that points back here.
    tools = body.get("tools") or []
    response_format = body.get("response_format") or {}
    json_schema = response_format.get("json_schema") or {}

    if tools:
        name = tools[0].get("function", {}).get("name", "")
        mode = "tools"
    elif json_schema:
        name = json_schema.get("name", "")
        mode = "json_schema"
    else:
        name, mode = "", "unstructured"

    REQUESTS.append(
        {
            "model": body.get("model"),
            "schema": name,
            "mode": mode,
            "messages": body.get("messages", []),
        }
    )

    arguments = RESPONSES.get(name)
    if arguments is None:
        # An unknown schema means the app changed shape and this stub is
        # stale — fail loudly rather than returning something plausible.
        raise HTTPException(
            status_code=500,
            detail=f"llm_stub has no canned response for schema {name!r} (mode={mode})",
        )

    message: dict[str, Any]
    if mode == "tools":
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_stub",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)},
                }
            ],
        }
        finish_reason = "tool_calls"
    else:
        message = {"role": "assistant", "content": json.dumps(arguments)}
        finish_reason = "stop"

    return {
        "id": "chatcmpl-stub",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model", "stub"),
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
