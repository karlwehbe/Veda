import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.conversations import ConversationOut
from app.db import get_db
from app.models import Conversation, Project
from app.services.notes_graph import MAX_INSTRUCTIONS_LEN

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])

MAX_NAME_LEN = 200
MAX_TYPE_LEN = 100
MAX_DESCRIPTION_LEN = 500


class ProjectIn(BaseModel):
    name: str = Field("", max_length=MAX_NAME_LEN)
    type: str = Field("", max_length=MAX_TYPE_LEN)
    # What this project is about, shown back to the user on the project
    # page — descriptive, not a directive, so it never reaches the writer.
    description: str = Field("", max_length=MAX_DESCRIPTION_LEN)
    # Same cap as the profile's Instructions field, and the same reason:
    # this text rides on every generation call for every conversation inside
    # the project.
    instructions: str = Field("", max_length=MAX_INSTRUCTIONS_LEN)


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    description: str
    # Unlike the profile's compiled_prompt, this is the user's own words —
    # there is nothing private about it, so it round-trips through the API
    # the same way the profile's Instructions field does.
    instructions: str
    conversation_count: int
    created_at: datetime
    updated_at: datetime


class ProjectDetailOut(ProjectOut):
    conversations: list[ConversationOut]


def _to_out(project: Project, conversation_count: int) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        type=project.type,
        description=project.description,
        instructions=project.instructions,
        conversation_count=conversation_count,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _get_project_or_404(project_id: uuid.UUID, db: Session) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="We couldn't find that project. It may have been deleted.")
    return project


@router.post("", response_model=ProjectOut)
def create_project(payload: ProjectIn, db: Session = Depends(get_db)) -> ProjectOut:
    project = Project(
        name=payload.name.strip(),
        type=payload.type.strip(),
        description=payload.description.strip(),
        instructions=payload.instructions.strip(),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    logger.info("[%s] project created", project.id)
    return _to_out(project, conversation_count=0)


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)) -> list[ProjectOut]:
    # One query for the projects, one grouped count query, joined in Python —
    # simpler than a correlated subquery per row and this table is small.
    projects = list(db.scalars(select(Project).order_by(Project.updated_at.desc())))
    counts = dict(
        db.execute(
            select(Conversation.project_id, func.count())
            .where(Conversation.project_id.is_not(None))
            .group_by(Conversation.project_id)
        ).all()
    )
    return [_to_out(p, counts.get(p.id, 0)) for p in projects]


@router.get("/{project_id}", response_model=ProjectDetailOut)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db)) -> ProjectDetailOut:
    project = _get_project_or_404(project_id, db)
    conversations = list(
        db.scalars(
            select(Conversation)
            .where(Conversation.project_id == project_id)
            .order_by(Conversation.updated_at.desc())
        )
    )
    out = _to_out(project, conversation_count=len(conversations))
    return ProjectDetailOut(**out.model_dump(), conversations=conversations)


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(project_id: uuid.UUID, payload: ProjectIn, db: Session = Depends(get_db)) -> ProjectOut:
    project = _get_project_or_404(project_id, db)
    project.name = payload.name.strip()
    project.type = payload.type.strip()
    project.description = payload.description.strip()
    project.instructions = payload.instructions.strip()
    db.commit()
    db.refresh(project)
    count = db.scalar(
        select(func.count()).select_from(Conversation).where(Conversation.project_id == project_id)
    )
    logger.info("[%s] project updated", project_id)
    return _to_out(project, conversation_count=count or 0)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db)) -> None:
    project = _get_project_or_404(project_id, db)
    # Deletes every conversation filed under this project, and their notes
    # and messages with them — the FK is ON DELETE CASCADE (db.py), chained
    # through Message.conversation_id's own CASCADE. One statement, no
    # explicit loop; the client is expected to confirm this with the user
    # before calling, since it's destructive and irreversible.
    db.delete(project)
    db.commit()
    logger.info("[%s] project deleted (its conversations were cascade-deleted)", project_id)
