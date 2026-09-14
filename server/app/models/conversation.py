import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String, nullable=False, default="New conversation")
    # NULL = not in any project ("Chats" in the sidebar). ON DELETE CASCADE at
    # the DB level: deleting a project deletes the conversations filed under
    # it too — and each of THEIR own ON DELETE CASCADE (Message.conversation_id)
    # chains from there, so one project delete removes its conversations and
    # every message inside them in a single statement.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # The persistent lecture-notes document — evolves across turns as the
    # user chats with the AI to refine it. Separate from Message.content,
    # which is just the short conversational reply shown in the chat thread.
    note_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Periodically autosaved from the live transcript while recording is in
    # progress — a safety net so a long recording isn't lost if the tab
    # crashes or the user navigates away before Send. Cleared once a real
    # Message is created on send.
    draft_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    messages = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at"
    )
    project = relationship("Project", back_populates="conversations")
