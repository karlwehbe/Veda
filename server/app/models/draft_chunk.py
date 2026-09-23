import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class DraftChunk(Base):
    """One piece of a conversation's autosaved draft transcript.

    Appending a chunk is a plain INSERT — no read of the draft so far, and no
    growing cost as the draft gets longer. The old design stored the whole
    draft as a single TEXT column that got rewritten in full on every
    autosave; under Postgres's MVCC an UPDATE always writes an entirely new
    row version, so that cost grew with the whole draft's length, not with
    the small bit of text that actually arrived. Reconstructing the full
    draft (ordered by id) only happens on the rare path that needs it — a
    reload recovering an in-progress recording — not on every autosave.
    """

    __tablename__ = "draft_chunks"

    # Global bigserial, not a per-conversation sequence — ordering comes for
    # free from insertion order, and assigning it needs no read of anything
    # (a per-conversation counter would require looking up the current max
    # first, reintroducing exactly the read-before-write this exists to avoid).
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    conversation = relationship("Conversation", back_populates="draft_chunks")
