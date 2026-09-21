"""The messages people actually receive, triggered through the real API.

The unit test scans the source for every message; this checks the ones that
matter most end to end — that what comes back over HTTP is product copy, and
that the message is the useful one (not a framework default).
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Conversation
from tests.copy_rules import assert_product_copy


def _conversation(db: Session, **kwargs) -> Conversation:
    conversation = Conversation(**kwargs)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


def _detail(response) -> str:
    detail = response.json()["detail"]
    assert isinstance(detail, str), f"detail must be a string a person can read, got {detail!r}"
    return detail


class TestNotFound:
    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/conversations/{id}"),
            ("delete", "/conversations/{id}"),
            ("get", "/projects/{id}"),
            ("delete", "/projects/{id}"),
            ("get", "/conversations/{id}/slides"),
            ("delete", "/conversations/{id}/slides/decks/{id}"),
            ("get", "/slides/{id}/image"),
            ("get", "/slides/{id}/thumbnail"),
        ],
    )
    def test_a_missing_thing_says_so_in_plain_words(self, client: TestClient, method: str, path: str) -> None:
        response = getattr(client, method)(path.replace("{id}", str(uuid.uuid4())))
        assert response.status_code == 404
        assert_product_copy(_detail(response))

    def test_it_says_what_could_not_be_found(self, client: TestClient) -> None:
        assert "conversation" in _detail(client.get(f"/conversations/{uuid.uuid4()}"))
        assert "project" in _detail(client.get(f"/projects/{uuid.uuid4()}"))

    def test_an_unknown_project_when_filing_a_conversation(self, client: TestClient) -> None:
        response = client.post(f"/conversations?project_id={uuid.uuid4()}")
        assert response.status_code == 404
        assert "project" in _detail(response)
        assert_product_copy(_detail(response))


class TestSendingSomethingUnusable:
    def test_nothing_to_send_says_what_to_do(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db)
        response = client.post(f"/conversations/{conversation.id}/messages", data={})
        assert response.status_code == 400
        assert_product_copy(_detail(response))
        # Tells the person what they could do, not what the API wanted.
        assert "type" in _detail(response).lower()

    def test_an_empty_file(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db)
        response = client.post(
            f"/conversations/{conversation.id}/messages",
            files={"file": ("silence.mp3", b"", "audio/mpeg")},
        )
        assert response.status_code == 400
        assert_product_copy(_detail(response))

    def test_a_file_that_is_too_large_says_the_limit(
        self, client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("app.api.conversations.MAX_AUDIO_BYTES", 5)
        conversation = _conversation(db)
        response = client.post(
            f"/conversations/{conversation.id}/messages",
            files={"file": ("long.mp3", b"more than five bytes", "audio/mpeg")},
        )
        assert response.status_code == 413
        assert_product_copy(_detail(response))
        assert "MB" in _detail(response)

    def test_silence_is_explained(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db)
        response = client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "   "})
        assert response.status_code == 400
        assert_product_copy(_detail(response))

    def test_a_failed_reply_says_to_try_again(
        self, client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def boom(*args, **kwargs):
            raise RuntimeError("openai: 401 invalid api key sk-live-123")

        monkeypatch.setattr("app.api.conversations.generate_response", boom)
        conversation = _conversation(db)

        response = client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture"})

        assert response.status_code == 503
        assert_product_copy(_detail(response))
        # Whatever the model said went to the log, not to the person.
        assert "401" not in response.text and "sk-live" not in response.text


class TestSlides:
    def test_slides_need_notes_first(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db, note_content=None)
        response = client.post(
            f"/conversations/{conversation.id}/slides/decks",
            files={"file": ("deck.pdf", b"%PDF-1.4", "application/pdf")},
        )
        assert response.status_code == 409
        assert_product_copy(_detail(response))

    def test_a_file_that_is_not_a_pdf(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db, note_content="# Notes")
        response = client.post(
            f"/conversations/{conversation.id}/slides/decks",
            files={"file": ("notes.pdf", b"this is not a pdf", "application/pdf")},
        )
        assert response.status_code == 400
        assert_product_copy(_detail(response))

    def test_an_empty_slide_file(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db, note_content="# Notes")
        response = client.post(
            f"/conversations/{conversation.id}/slides/decks",
            files={"file": ("deck.pdf", b"", "application/pdf")},
        )
        assert response.status_code == 400
        assert_product_copy(_detail(response))


class TestMalformedRequests:
    """FastAPI's own validation errors carry a list of objects in `detail`. The
    client turns those into a plain sentence; this pins the shape it has to cope
    with, so a change to it is noticed."""

    def test_a_validation_error_is_not_a_readable_message(self, client: TestClient, db: Session) -> None:
        conversation = _conversation(db)
        response = client.patch(f"/conversations/{conversation.id}/slides", json={"add": ["not-a-uuid"]})
        assert response.status_code == 422
        assert isinstance(response.json()["detail"], list)
