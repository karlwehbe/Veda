import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, LargeBinary, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class SlideDeck(Base):
    """An uploaded slide PDF, kept for the life of the conversation.

    Every page of it becomes a Slide row (with a thumbnail and its text) the
    moment it is uploaded, whether or not the user has put that page in the
    notes. The PDF itself is kept so a page can be rendered at full size the
    first time it is ticked, and re-rendered if it is unticked and ticked again —
    without the user having to upload the file a second time. It is the one big
    column, so it is deferred: only the code that renders a page loads it.
    """

    __tablename__ = "slide_decks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    filename: Mapped[str] = mapped_column(String, nullable=False, default="slides.pdf")
    page_count: Mapped[int] = mapped_column(Integer, nullable=False)
    pdf: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, deferred=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    conversation = relationship("Conversation", back_populates="decks")
    slides = relationship(
        "Slide", back_populates="deck", cascade="all, delete-orphan", order_by="Slide.position"
    )
