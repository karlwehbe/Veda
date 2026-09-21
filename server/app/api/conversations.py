import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.models import Conversation, Message, Project
from app.services.notes_graph import generate_response
from app.services.slides import notes_with_slides, sync_slide_placements
from app.services.transcription import transcribe_audio

logger = logging.getLogger(__name__)

router = APIRouter(tags=["conversations"])

MAX_AUDIO_BYTES = 25 * 1024 * 1024  # Deepgram's own upload limit
TITLE_MAX_LEN = 60


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    filename: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str
    project_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ConversationDetailOut(ConversationOut):
    messages: list[MessageOut]
    note_content: str | None
    draft_transcript: str | None
    # Every page kept for editing, in the notes or not — so the client knows a
    # deck exists (and offers "Manage slides") even when nothing is included.
    slide_count: int = 0


class MessageTurnOut(BaseModel):
    user_message: MessageOut
    assistant_message: MessageOut
    note_content: str | None
    title: str
    slide_count: int = 0


def _get_conversation_or_404(conversation_id: uuid.UUID, db: Session) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="We couldn't find that conversation. It may have been deleted.")
    return conversation


@router.post("/conversations", response_model=ConversationOut)
def create_conversation(
    # Optional: a project's "New chat" button passes its own id so the
    # conversation is filed there from creation, instead of the flat "Chats"
    # list. A live recording also creates eagerly (before any transcript
    # exists) via this same endpoint, so the query param has to cover both.
    project_id: uuid.UUID | None = None,
    db: Session = Depends(get_db),
) -> Conversation:
    if project_id is not None and db.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="We couldn't find that project. It may have been deleted.")
    conversation = Conversation(project_id=project_id)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    logger.info("[%s] conversation created (project=%s)", conversation.id, project_id)
    return conversation


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(db: Session = Depends(get_db)) -> list[Conversation]:
    stmt = select(Conversation).order_by(Conversation.updated_at.desc())
    return list(db.scalars(stmt))


@router.get("/conversations/{conversation_id}", response_model=ConversationDetailOut)
def get_conversation(conversation_id: uuid.UUID, db: Session = Depends(get_db)) -> ConversationDetailOut:
    conversation = _get_conversation_or_404(conversation_id, db)
    out = ConversationDetailOut.model_validate(conversation)
    # The stored notes are slide-free; the client gets them with each slide's
    # image markdown injected (see app/services/slides.py).
    out.note_content = notes_with_slides(conversation.note_content, conversation.slides)
    out.slide_count = len(conversation.slides)
    return out


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conversation_id: uuid.UUID, db: Session = Depends(get_db)) -> None:
    conversation = _get_conversation_or_404(conversation_id, db)
    db.delete(conversation)
    db.commit()
    logger.info("[%s] conversation deleted", conversation_id)


class DraftIn(BaseModel):
    transcript: str


# Called periodically by the client while a recording is in progress, so the
# transcript captured so far survives a crash/reload even before the user
# gets to Send — overwrites draft_transcript wholesale each time rather than
# appending, since the client always sends the full accumulated transcript.
@router.patch("/conversations/{conversation_id}/draft", status_code=status.HTTP_204_NO_CONTENT)
def save_draft(conversation_id: uuid.UUID, payload: DraftIn, db: Session = Depends(get_db)) -> None:
    conversation = _get_conversation_or_404(conversation_id, db)
    conversation.draft_transcript = payload.transcript
    db.commit()
    # DEBUG, not INFO — this fires every few seconds for the whole duration
    # of a recording and would otherwise drown out the rest of the workflow.
    logger.debug("[%s] draft autosaved (%d chars)", conversation_id, len(payload.transcript))


@router.post("/conversations/{conversation_id}/messages", response_model=MessageTurnOut)
async def send_message(
    conversation_id: uuid.UUID,
    # Audio is optional — required for file uploads (batch STT). Live
    # recordings and typed messages omit it.
    file: UploadFile | None = File(None),
    # Live recording / typed text: the message content. File uploads leave
    # this unset so the server runs batch transcription on `file`.
    transcript: str | None = Form(None),
    # Optional label without audio bytes — live send uses "recording.webm"
    # so the turn is distinguishable from typed text. Ignored when `file`
    # is present (the upload's own name wins).
    filename: str | None = Form(None),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> MessageTurnOut:
    conversation = _get_conversation_or_404(conversation_id, db)
    logger.info(
        "[%s] message received (%s)",
        conversation_id,
        f"audio file {file.filename!r}" if file is not None else "text",
    )

    stored_filename: str | None = None
    if file is not None:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That file is empty.")
        if len(audio_bytes) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="That file is too large. Audio files can be up to 25 MB.")
        logger.info("[%s] transcribing %d bytes of audio", conversation_id, len(audio_bytes))
        transcript = await transcribe_audio(audio_bytes, settings)
        logger.info("[%s] transcription complete (%d chars)", conversation_id, len(transcript))
        stored_filename = file.filename or "recording.webm"
    elif transcript:
        stored_filename = filename
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="There's nothing to send. Type a message, record, or attach an audio file.")

    # Silence (or a file with no discernible speech) transcribes to an empty
    # string — bail before persisting anything, so the conversation keeps its
    # default "New conversation" title instead of it being overwritten below,
    # and no blank message is saved.
    if not transcript.strip():
        logger.info("[%s] no speech detected, rejecting", conversation_id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="We couldn't hear any speech in that recording. Please try again.",
        )

    history = [{"role": m.role, "content": m.content} for m in conversation.messages]

    user_message = Message(
        conversation_id=conversation.id,
        role="user",
        content=transcript,
        filename=stored_filename,
    )
    db.add(user_message)
    # Persist the user turn immediately so a crash mid-generation doesn't lose
    # what they sent. Cleared again below if the model call fails, so a soft
    # failure can restore the text into the composer for a clean retry.
    conversation.draft_transcript = None
    conversation.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(user_message)
    logger.info("[%s] user message saved (%d chars)", conversation_id, len(transcript))

    logger.info(
        "[%s] generating response (llm=%s, routing=%s, %d prior turns)",
        conversation_id,
        settings.llm_model,
        settings.routing_llm_model,
        len(history),
    )
    try:
        turn = await generate_response(
            transcript,
            history,
            conversation.note_content,
            conversation.title,
            settings,
            db,
            project_id=conversation.project_id,
        )
    except HTTPException:
        db.delete(user_message)
        db.commit()
        raise
    except Exception:
        logger.exception("[%s] response generation failed", conversation_id)
        db.delete(user_message)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="We couldn't generate a response. Please try again.",
        ) from None

    logger.info(
        "[%s] response generated (notes_updated=%s, reply %d chars) — %s",
        conversation_id,
        turn.notes_updated,
        len(turn.chat_reply),
        turn.decision_reason,
    )
    assistant_message = Message(conversation_id=conversation.id, role="assistant", content=turn.chat_reply)
    db.add(assistant_message)

    # Only persist notes when the graph actually routed through its
    # note-writing branch — a chat-only turn must leave the document exactly
    # as it was.
    if turn.notes_updated and turn.note_content is not None:
        conversation.note_content = turn.note_content
        # Notes were rewritten, so every slide's line number may be stale.
        # Anchors are re-found by string match; only orphans reach the LLM,
        # and a placement failure never fails the turn.
        await sync_slide_placements(list(conversation.slides), conversation.note_content, settings)
    if conversation.title == "New conversation" and turn.title.strip():
        conversation.title = turn.title.strip()[:TITLE_MAX_LEN]
    conversation.updated_at = datetime.now(UTC)

    db.commit()
    db.refresh(user_message)
    db.refresh(assistant_message)
    db.refresh(conversation)
    logger.info("[%s] message saved (title=%r)", conversation_id, conversation.title)
    return MessageTurnOut(
        user_message=MessageOut.model_validate(user_message),
        assistant_message=MessageOut.model_validate(assistant_message),
        # Always the stored document, so a chat-only turn doesn't blank the
        # notes panel client-side.
        note_content=notes_with_slides(conversation.note_content, conversation.slides),
        title=conversation.title,
        slide_count=len(conversation.slides),
    )
