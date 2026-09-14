"""Integration tests: the conversations API against a real Postgres.

The LLM and Deepgram are stubbed. Everything else is real — routing through
FastAPI, SQLAlchemy, actual JSONB/UUID columns, real commits. These cover the
turn lifecycle, which is where a failure loses someone's lecture.
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Conversation, Message
from app.services.notes_graph import TurnResult

NOTES = "# Vectors\n\nA vector has magnitude and direction."


@pytest.fixture
def stub_llm(monkeypatch: pytest.MonkeyPatch):
    """Replaces generate_response with a deterministic stub.

    Patched where it is *used* (app.api.conversations), not where it is
    defined — conversations.py imported the name at module load, so patching
    the source module would leave the bound reference untouched.
    """

    def _stub(
        result: TurnResult | None = None,
        *,
        raises: Exception | None = None,
    ) -> list[dict]:
        calls: list[dict] = []

        async def fake_generate_response(
            transcript, history, current_note, current_title, settings, db, project_id=None
        ):
            calls.append(
                {
                    "transcript": transcript,
                    "history": history,
                    "current_note": current_note,
                    "current_title": current_title,
                    "project_id": project_id,
                }
            )
            if raises is not None:
                raise raises
            return result or TurnResult(
                note_content=NOTES,
                chat_reply="Started your notes on vectors.",
                title="Vectors",
                notes_updated=True,
                decision_reason="substantive lecture content",
            )

        monkeypatch.setattr("app.api.conversations.generate_response", fake_generate_response)
        return calls

    return _stub


def _make_conversation(db: Session, **kwargs) -> Conversation:
    conversation = Conversation(**kwargs)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


class TestConversationLifecycle:
    def test_create_returns_the_placeholder_title(self, client: TestClient) -> None:
        response = client.post("/conversations")
        assert response.status_code == 200
        assert response.json()["title"] == "New conversation"

    def test_list_is_empty_to_start(self, client: TestClient) -> None:
        assert client.get("/conversations").json() == []

    def test_get_missing_conversation_is_404(self, client: TestClient) -> None:
        assert client.get(f"/conversations/{uuid.uuid4()}").status_code == 404

    def test_delete_cascades_to_messages(self, client: TestClient, db: Session) -> None:
        conversation = _make_conversation(db)
        db.add(Message(conversation_id=conversation.id, role="user", content="hello"))
        db.commit()

        assert client.delete(f"/conversations/{conversation.id}").status_code == 204
        assert db.query(Message).count() == 0, "messages outlived their conversation"


class TestDraftAutosave:
    def test_draft_round_trips(self, client: TestClient, db: Session) -> None:
        conversation = _make_conversation(db)
        assert client.patch(
            f"/conversations/{conversation.id}/draft", json={"transcript": "half a lecture"}
        ).status_code == 204
        assert client.get(f"/conversations/{conversation.id}").json()["draft_transcript"] == "half a lecture"

    def test_draft_is_overwritten_not_appended(self, client: TestClient, db: Session) -> None:
        # The client always sends the full accumulated transcript.
        conversation = _make_conversation(db)
        for text in ("one", "one two"):
            client.patch(f"/conversations/{conversation.id}/draft", json={"transcript": text})
        assert client.get(f"/conversations/{conversation.id}").json()["draft_transcript"] == "one two"


class TestSendMessage:
    def test_typed_message_persists_both_turns(self, client: TestClient, db: Session, stub_llm) -> None:
        stub_llm()
        conversation = _make_conversation(db)

        response = client.post(
            f"/conversations/{conversation.id}/messages",
            data={"transcript": "a vector has magnitude and direction"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["user_message"]["role"] == "user"
        assert body["assistant_message"]["role"] == "assistant"
        assert db.query(Message).count() == 2

    def test_live_recording_sets_filename_without_audio_file(
        self, client: TestClient, db: Session, stub_llm
    ) -> None:
        # Live path: transcript + filename metadata, no multipart file.
        stub_llm()
        conversation = _make_conversation(db)

        response = client.post(
            f"/conversations/{conversation.id}/messages",
            data={"transcript": "lecture content", "filename": "recording.webm"},
        )

        assert response.status_code == 200
        user = db.query(Message).filter_by(role="user").one()
        assert user.content == "lecture content"
        assert user.filename == "recording.webm"

    def test_notes_are_persisted_when_the_router_says_so(self, client: TestClient, db: Session, stub_llm) -> None:
        stub_llm()
        conversation = _make_conversation(db)
        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture content"})
        db.refresh(conversation)
        assert conversation.note_content == NOTES

    def test_chat_only_turn_leaves_the_document_alone(self, client: TestClient, db: Session, stub_llm) -> None:
        # The regression that used to blank the notes panel: a chat reply must
        # not overwrite the stored document.
        stub_llm(
            TurnResult(
                note_content=None,
                chat_reply="A vector has magnitude and direction.",
                title="Vectors",
                notes_updated=False,
                decision_reason="question for the chat",
            )
        )
        conversation = _make_conversation(db, note_content=NOTES, title="Vectors")

        response = client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "what is a vector?"})

        db.refresh(conversation)
        assert conversation.note_content == NOTES
        assert response.json()["note_content"] == NOTES, "the response blanked the notes panel"

    def test_first_turn_sets_the_title(self, client: TestClient, db: Session, stub_llm) -> None:
        stub_llm()
        conversation = _make_conversation(db)
        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture"})
        db.refresh(conversation)
        assert conversation.title == "Vectors"

    def test_an_existing_title_is_kept(self, client: TestClient, db: Session, stub_llm) -> None:
        stub_llm()
        conversation = _make_conversation(db, title="Linear Algebra Week 1")
        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture"})
        db.refresh(conversation)
        assert conversation.title == "Linear Algebra Week 1"

    def test_sending_clears_the_draft(self, client: TestClient, db: Session, stub_llm) -> None:
        stub_llm()
        conversation = _make_conversation(db, draft_transcript="stale draft")
        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture"})
        db.refresh(conversation)
        assert conversation.draft_transcript is None

    def test_prior_turns_are_passed_as_history(self, client: TestClient, db: Session, stub_llm) -> None:
        # The routing rules depend on seeing the previous assistant turn.
        calls = stub_llm()
        conversation = _make_conversation(db)
        db.add(Message(conversation_id=conversation.id, role="user", content="earlier question"))
        db.add(Message(conversation_id=conversation.id, role="assistant", content="earlier answer"))
        db.commit()

        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "yes"})

        history = calls[0]["history"]
        assert [turn["content"] for turn in history] == ["earlier question", "earlier answer"]

    def test_current_message_is_not_duplicated_into_history(self, client: TestClient, db: Session, stub_llm) -> None:
        calls = stub_llm()
        conversation = _make_conversation(db)
        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "the new input"})
        assert calls[0]["history"] == []

    def test_the_conversations_project_reaches_generate_response(
        self, client: TestClient, db: Session, stub_llm
    ) -> None:
        # generate_response resolves the project's own instructions itself
        # (see notes_graph._project_instructions) — this just confirms the id
        # it needs to do that is actually passed through from the DB row.
        from app.models import Project

        project = Project(name="Linear Algebra", type="Course", instructions="")
        db.add(project)
        db.commit()
        db.refresh(project)

        calls = stub_llm()
        conversation = _make_conversation(db, project_id=project.id)
        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture"})

        assert calls[0]["project_id"] == project.id


class TestSendMessageRejections:
    def test_empty_request_is_rejected(self, client: TestClient, db: Session) -> None:
        conversation = _make_conversation(db)
        assert client.post(f"/conversations/{conversation.id}/messages", data={}).status_code == 400

    def test_whitespace_only_transcript_is_rejected(self, client: TestClient, db: Session) -> None:
        # Silence transcribes to nothing; a blank message must not be stored
        # and the placeholder title must survive.
        conversation = _make_conversation(db)
        response = client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "   "})
        assert response.status_code == 400
        assert db.query(Message).count() == 0
        db.refresh(conversation)
        assert conversation.title == "New conversation"

    def test_unknown_conversation_is_404(self, client: TestClient) -> None:
        response = client.post(f"/conversations/{uuid.uuid4()}/messages", data={"transcript": "hello"})
        assert response.status_code == 404

    def test_generation_failure_rolls_back_the_user_message(
        self, client: TestClient, db: Session, stub_llm
    ) -> None:
        # A failed turn must not leave a user message with no reply — the UI
        # would show it as sent and the retry would duplicate it.
        stub_llm(raises=RuntimeError("model exploded"))
        conversation = _make_conversation(db)

        response = client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "lecture"})

        assert response.status_code == 503
        assert db.query(Message).count() == 0

    @pytest.mark.xfail(
        strict=True,
        reason="Known bug: draft_transcript is cleared before generation and never restored on failure",
    )
    def test_generation_failure_restores_the_draft(self, client: TestClient, db: Session, stub_llm) -> None:
        # conversations.py's own comment promises this ("cleared again below if
        # the model call fails, so a soft failure can restore the text"), but
        # the failure path only deletes the message. A tab crash here loses it.
        stub_llm(raises=RuntimeError("model exploded"))
        conversation = _make_conversation(db, draft_transcript="an hour of lecture")

        client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "an hour of lecture"})

        db.refresh(conversation)
        assert conversation.draft_transcript == "an hour of lecture"
