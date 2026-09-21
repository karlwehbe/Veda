"""Slide decks: upload a PDF once, then choose which of its pages are in the notes.

An upload keeps the *whole* deck — the PDF, and a row per page with its thumbnail
and text — but puts nothing in the notes. Which pages are in the notes is a
separate, incremental choice (`PATCH .../slides`): adding a page renders and
places that page alone, removing one touches only that page, and a removed page
stays available to be ticked again without uploading the PDF a second time.
"""

import logging
import os
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, undefer

from app.api.conversations import _get_conversation_or_404
from app.config import Settings, get_settings
from app.db import get_db
from app.models import Conversation, Slide, SlideDeck
from app.services.slides import (
    MAX_PDF_BYTES,
    MAX_SLIDES_PER_CONVERSATION,
    PdfError,
    is_placed,
    notes_with_slides,
    read_deck,
    render_images,
    slide_alt,
    sync_slide_placements,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["slides"])

# A slide's bytes never change once stored, so browsers can keep them forever.
IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable"
FILENAME_MAX_LEN = 200


class SlideOut(BaseModel):
    id: uuid.UUID
    # The PDF this page came from. None only for slides stored before decks were
    # kept: their PDF is gone, so they can be removed but not added back.
    deck_id: uuid.UUID | None
    deck_name: str | None
    position: int
    page_number: int
    alt: str
    # Whether the page is in the notes. Every page of an uploaded deck is listed;
    # only included ones are rendered into them.
    included: bool
    # An included page with no spot in the notes yet (the notes don't cover it,
    # or placement failed): kept, hidden, and retried after each notes update.
    placed: bool


class SlidesOut(BaseModel):
    slides: list[SlideOut]
    # The notes with every included slide's image injected, so the client can swap
    # its notes panel content without a refetch.
    note_content: str | None


class DeckUploadedOut(SlidesOut):
    deck_id: uuid.UUID


class ChangeSlidesIn(BaseModel):
    # Slide ids to put in the notes / take out of them. Ids that are already in
    # the requested state, or don't belong to this conversation, are ignored.
    add: list[uuid.UUID] = Field(default_factory=list)
    remove: list[uuid.UUID] = Field(default_factory=list)


def _slide_out(slide: Slide, note: str | None, deck_names: dict[uuid.UUID, str]) -> SlideOut:
    n_lines = len(note.split("\n")) if note else 0
    return SlideOut(
        id=slide.id,
        deck_id=slide.deck_id,
        deck_name=deck_names.get(slide.deck_id) if slide.deck_id else None,
        position=slide.position,
        page_number=slide.page_number,
        alt=slide_alt(slide),
        included=slide.included,
        placed=slide.included and is_placed(slide, n_lines),
    )


def _slides_out(conversation: Conversation) -> SlidesOut:
    names = {d.id: d.filename for d in conversation.decks}
    return SlidesOut(
        slides=[_slide_out(s, conversation.note_content, names) for s in conversation.slides],
        note_content=notes_with_slides(conversation.note_content, conversation.slides),
    )


def _require_notes(conversation: Conversation) -> None:
    # Slides are placed against the notes, so there has to be something to
    # place them in. The UI disables the button too; this is the real gate.
    if not (conversation.note_content or "").strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Slides can be added once notes have been generated.",
        )


async def _read_pdf(file: UploadFile) -> bytes:
    data = await file.read(MAX_PDF_BYTES + 1)
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That file is empty.")
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="That PDF is too large (30 MB max).")
    return data


def _clear_placement(slide: Slide) -> None:
    slide.after_line = None
    slide.anchor_text = None
    slide.anchor_heading = None


@router.post("/conversations/{conversation_id}/slides/decks", response_model=DeckUploadedOut)
async def upload_deck(
    conversation_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> DeckUploadedOut:
    """Keep the whole PDF: a thumbnail and the text of every page, and the PDF
    itself for rendering pages later. Nothing goes in the notes and no model is
    called — that waits for the pages the user ticks."""
    conversation = _get_conversation_or_404(conversation_id, db)
    _require_notes(conversation)
    data = await _read_pdf(file)
    try:
        pages = await run_in_threadpool(read_deck, data)
    except PdfError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None
    existing = list(conversation.slides)
    if len(existing) + len(pages) > MAX_SLIDES_PER_CONVERSATION:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"A conversation can hold at most {MAX_SLIDES_PER_CONVERSATION} slides.",
        )

    deck = SlideDeck(
        conversation_id=conversation.id,
        filename=(os.path.basename(file.filename or "") or "slides.pdf")[:FILENAME_MAX_LEN],
        page_count=len(pages),
        pdf=data,
    )
    db.add(deck)
    db.flush()
    next_position = max((s.position for s in existing), default=0) + 1
    for offset, page in enumerate(pages):
        db.add(
            Slide(
                conversation_id=conversation.id,
                deck_id=deck.id,
                position=next_position + offset,
                page_number=page.page_number,
                image=None,
                image_type="image/png",
                thumbnail=page.thumbnail,
                text=page.text,
                included=False,
            )
        )
    conversation.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(conversation)
    logger.info("[%s] deck %r kept (%d pages, none in the notes yet)", conversation_id, deck.filename, len(pages))
    return DeckUploadedOut(deck_id=deck.id, **_slides_out(conversation).model_dump())


@router.patch("/conversations/{conversation_id}/slides", response_model=SlidesOut)
async def change_slides(
    conversation_id: uuid.UUID,
    payload: ChangeSlidesIn,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> SlidesOut:
    """Put pages in the notes / take pages out — and touch only those pages.

    Pages being added are rendered from the kept PDF and placed (the placement
    model is asked about them alone; every slide already in the notes keeps its
    spot). Pages being removed are just taken out — nothing else is re-run — and
    stay in the deck so they can be added again without uploading it twice.
    """
    conversation = _get_conversation_or_404(conversation_id, db)
    by_id = {s.id: s for s in conversation.slides}
    to_add = [by_id[i] for i in dict.fromkeys(payload.add) if i in by_id and not by_id[i].included]
    to_remove = [by_id[i] for i in dict.fromkeys(payload.remove) if i in by_id and by_id[i].included]

    if to_add:
        _require_notes(conversation)
        # One render per deck, of just the pages being added.
        wanted: dict[uuid.UUID, list[Slide]] = {}
        for slide in to_add:
            if slide.deck_id is not None:
                wanted.setdefault(slide.deck_id, []).append(slide)
        for deck_id, slides in wanted.items():
            deck = db.scalar(select(SlideDeck).where(SlideDeck.id == deck_id).options(undefer(SlideDeck.pdf)))
            if deck is None:  # can't happen while the FK holds; be safe
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="We couldn't find that PDF. It may have been removed.")
            try:
                images = await run_in_threadpool(render_images, deck.pdf, sorted(s.page_number for s in slides))
            except PdfError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None
            by_page = {img.page_number: img for img in images}
            for slide in slides:
                image = by_page[slide.page_number]
                slide.image = image.image
                slide.image_type = image.image_type
                slide.included = True
                _clear_placement(slide)  # a new page has no spot yet — it is placed below

    for slide in to_remove:
        if slide.deck_id is None:
            # An early slide whose PDF was never kept: nothing to add it back from.
            conversation.slides.remove(slide)
        else:
            slide.included = False
            slide.image = None  # re-rendered from the PDF if it is ticked again
            _clear_placement(slide)

    db.flush()
    db.refresh(conversation)
    if to_add:
        logger.info("[%s] adding %d slide(s), removing %d; placing the new ones", conversation_id, len(to_add), len(to_remove))
        # Slides already in the notes resolve by string match; only the new ones
        # (no anchor yet) reach the placement model.
        await sync_slide_placements(list(conversation.slides), conversation.note_content, settings)
    else:
        logger.info("[%s] removing %d slide(s)", conversation_id, len(to_remove))
    conversation.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(conversation)
    return _slides_out(conversation)


@router.get("/conversations/{conversation_id}/slides", response_model=list[SlideOut])
def list_slides(conversation_id: uuid.UUID, db: Session = Depends(get_db)) -> list[SlideOut]:
    conversation = _get_conversation_or_404(conversation_id, db)
    return _slides_out(conversation).slides


@router.delete("/conversations/{conversation_id}/slides/decks/{deck_id}", response_model=SlidesOut)
def delete_deck(conversation_id: uuid.UUID, deck_id: uuid.UUID, db: Session = Depends(get_db)) -> SlidesOut:
    """Forget an uploaded PDF entirely — its pages leave the notes and the deck is
    gone (unlike un-ticking a page, which keeps it available)."""
    conversation = _get_conversation_or_404(conversation_id, db)
    deck = next((d for d in conversation.decks if d.id == deck_id), None)
    if deck is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="We couldn't find that PDF. It may have been removed.")
    conversation.decks.remove(deck)  # delete-orphan removes it and its pages
    db.commit()
    db.refresh(conversation)
    logger.info("[%s] deck %r deleted", conversation_id, deck.filename)
    return _slides_out(conversation)


def _image_response(request: Request, slide_id: uuid.UUID, db: Session, *, thumbnail: bool) -> Response:
    column = Slide.thumbnail if thumbnail else Slide.image
    slide = db.scalar(select(Slide).where(Slide.id == slide_id).options(undefer(column)))
    content = None if slide is None else (slide.thumbnail if thumbnail else slide.image)
    # A page that isn't in the notes has a thumbnail but no full-size image.
    if slide is None or content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="We couldn't find that slide.")
    etag = f'"{slide.id}-{"t" if thumbnail else "i"}"'
    headers = {"Cache-Control": IMAGE_CACHE_CONTROL, "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(
        content=content,
        media_type="image/jpeg" if thumbnail else slide.image_type,
        headers=headers,
    )


@router.get("/slides/{slide_id}/image")
def slide_image(slide_id: uuid.UUID, request: Request, db: Session = Depends(get_db)) -> Response:
    return _image_response(request, slide_id, db, thumbnail=False)


@router.get("/slides/{slide_id}/thumbnail")
def slide_thumbnail(slide_id: uuid.UUID, request: Request, db: Session = Depends(get_db)) -> Response:
    return _image_response(request, slide_id, db, thumbnail=True)
