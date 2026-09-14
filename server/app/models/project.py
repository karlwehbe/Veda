import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Project(Base):
    """A folder grouping conversations — a course, a research project, a
    reading group. Flat: a project holds conversations directly and cannot
    contain other projects, and a conversation belongs to at most one."""

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False, default="New project")
    # Free text — "Course", "Research", whatever the user calls it. Not an
    # enum: nothing in the app branches on the value yet, and constraining it
    # now would mean guessing at categories nobody asked for.
    type: Mapped[str] = mapped_column(String, nullable=False, default="")
    # What this project is about, in the user's own words — shown back to
    # them on the project page. Distinct from `instructions`: this is
    # descriptive context, not a directive sent to the writer.
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # The user's own directions for how notes in this project should be
    # written — same treatment as the profile's Instructions field: passed to
    # the writer verbatim, never paraphrased. Capped in the API layer.
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Deleting a project deletes the conversations filed under it, and their
    # notes with them — the FK is ON DELETE CASCADE (see db.py). passive_deletes
    # lets that DB-level behavior do the work instead of the ORM loading every
    # row into memory just to delete it one at a time.
    conversations = relationship("Conversation", back_populates="project", passive_deletes=True)
