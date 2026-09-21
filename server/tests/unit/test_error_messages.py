"""Error messages are product copy.

The client shows the API's `detail` text to people exactly as written, so it has
to read like a real product: a sentence, no jargon, nothing about keys, providers
or deploys. This scans every user-facing string in the server's source, so a new
message written in developer-speak fails here rather than reaching a screen.
"""

import pathlib
import re

import pytest
from fastapi import HTTPException

from app.config import Settings
from app.services.notes_graph import _resolve_llm
from app.services.transcription import transcribe_audio
from tests.copy_rules import FORBIDDEN, assert_product_copy

APP = pathlib.Path(__file__).resolve().parents[2] / "app"

# detail="..." / detail=f"..." (also across a line break), the PDF errors, and the
# reason on a WebSocket close — the three places text is written for a person.
PATTERNS = (
    re.compile(r'detail\s*=\s*\(?\s*f?"([^"\n]+)"'),
    re.compile(r'PdfError\(\s*f?"([^"\n]+)"'),
    re.compile(r'reason\s*=\s*f?"([^"\n]+)"'),
)


def _messages() -> list[tuple[str, str]]:
    found = []
    for path in sorted(APP.rglob("*.py")):
        source = path.read_text()
        for pattern in PATTERNS:
            for match in pattern.finditer(source):
                # An f-string placeholder stands for a number or a name.
                text = re.sub(r"\{[^}]+\}", "3", match.group(1))
                found.append((f"{path.relative_to(APP)}", text))
    return found


def test_the_scan_actually_finds_the_messages() -> None:
    # Guards against the patterns silently matching nothing and the test passing
    # for the wrong reason.
    assert len(_messages()) >= 20


@pytest.mark.parametrize(("where", "text"), _messages())
def test_every_message_reads_like_product_copy(where: str, text: str) -> None:
    assert_product_copy(text)


def test_the_rules_reject_what_they_are_for() -> None:
    for bad in (
        "Empty file",  # a fragment, not a sentence
        "Deck not found",  # API-speak
        "Transcription is not configured",  # configuration
        "LLM provider 'openai' is not configured (missing API key)",  # keys and providers
        "Internal server error 500.",  # a status code
        "Run ./redeploy.sh and try again.",  # a deploy instruction
    ):
        with pytest.raises(AssertionError):
            assert_product_copy(bad)


def test_the_forbidden_list_is_not_empty() -> None:
    assert "api key" in FORBIDDEN and "redeploy" in FORBIDDEN


class TestMissingConfiguration:
    """A deployment missing a key is the operator's problem. The person using the
    app gets "not available right now" — never which key, or which provider."""

    async def test_no_transcription_key(self) -> None:
        with pytest.raises(HTTPException) as caught:
            await transcribe_audio(b"audio", Settings(deepgram_api_key=""))
        assert caught.value.status_code == 503
        assert_product_copy(caught.value.detail)

    def test_no_model_key(self) -> None:
        with pytest.raises(HTTPException) as caught:
            _resolve_llm(Settings(openai_api_key=""))
        assert caught.value.status_code == 503
        assert_product_copy(caught.value.detail)
        assert "openai" not in caught.value.detail.lower()

    def test_an_unknown_provider_says_the_same_thing(self) -> None:
        with pytest.raises(HTTPException) as caught:
            _resolve_llm(Settings(llm_model="mystery:model-1"))
        assert_product_copy(caught.value.detail)
