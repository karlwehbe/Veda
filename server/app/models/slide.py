import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Slide(Base):
    """One kept page of an uploaded slide deck, tied to a conversation.

    The notes document (Conversation.note_content) never contains slides —
    the writer LLM can't drop or mangle what it never sees. Each slide instead
    remembers *where* it sits via a stable anchor (the text of the line it
    follows, plus the nearest heading above it), and the image markdown is
    injected only when notes are returned to the client. See
    app/services/slides.py.
    """

    __tablename__ = "slides"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The uploaded PDF this page belongs to. NULL only for slides stored before
    # decks were kept: their PDF is gone, so they can be removed but not re-added.
    deck_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("slide_decks.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Whether the page is in the notes. Every page of an uploaded deck exists as
    # a row (thumbnail + text) from the moment of upload, so the edit dialog can
    # show the whole deck; only "included" ones are placed, rendered into the
    # notes, and sent to the placement model.
    included: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    # Order within the conversation (deck order; a later upload continues
    # after the last one). Gaps are fine — deleting a slide doesn't renumber.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    # 1-based page in the uploaded PDF, for display only.
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # The image bytes are deferred: the per-turn work (resolving anchors,
    # injecting markdown) only needs the text columns, and would otherwise
    # pull megabytes of bytea out of Postgres on every notes update. Only the
    # image endpoints (and the vision placement path) undefer them.
    # The full-size render. Made the first time the page is included and dropped
    # again when it is removed (it can be re-rendered from the deck's PDF), so
    # NULL for every page that isn't in the notes.
    image: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    image_type: Mapped[str] = mapped_column(String, nullable=False, default="image/png")
    thumbnail: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
    # Text layer of the page ("" for scanned/image-only slides).
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Where the slide sits in the current notes. NULL anchor = not placed
    # (notes don't cover it yet, or placement failed) — it is hidden from the
    # notes and retried on every notes rewrite until it finds a spot.
    anchor_heading: Mapped[str | None] = mapped_column(Text, nullable=True)
    anchor_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 0-based line index of anchor_text in the current notes; a cache that is
    # re-resolved from the anchor after every rewrite.
    after_line: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    conversation = relationship("Conversation", back_populates="slides")
    deck = relationship("SlideDeck", back_populates="slides")
