"""Integration tests: the slides API against a real Postgres.

The LLM is stubbed at both seams — generate_response (the notes writer) and
place_slides (the slide matcher). Everything else is real: PyMuPDF rendering,
the multipart uploads, SQLAlchemy, the deferred columns.

The model under test: an upload keeps the WHOLE deck (a row per page, none in the
notes yet); which pages are in the notes is a separate, incremental choice, and
each change touches only the pages it names.
"""

import uuid

import pymupdf
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Conversation, Slide, SlideDeck
from app.services.notes_graph import TurnResult

NOTES = "# Vectors\n\nA vector has magnitude and direction.\n\n## Dot product\n\nThe dot product is a scalar."


def make_pdf(pages: int = 4) -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 60), f"Slide {i + 1} title\nbody text for slide {i + 1}")
    data = doc.tobytes()
    doc.close()
    return data


def make_conversation(db: Session, note: str | None = NOTES) -> Conversation:
    conversation = Conversation(note_content=note)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


@pytest.fixture
def placer(monkeypatch: pytest.MonkeyPatch):
    """Stubs place_slides. `calls` records the slide positions of every call;
    `answers` maps position -> 0-based line (absent = no spot)."""
    calls: list[list[int]] = []
    answers: dict[int, int | None] = {}

    async def fake_place_slides(note, to_place, placed, settings):
        calls.append(sorted(s.position for s in to_place))
        return {s.position: answers.get(s.position) for s in to_place}

    monkeypatch.setattr("app.services.slides.place_slides", fake_place_slides)
    fake_place_slides.calls = calls  # type: ignore[attr-defined]
    fake_place_slides.answers = answers  # type: ignore[attr-defined]
    return fake_place_slides


def upload(client: TestClient, conversation: Conversation, pdf: bytes | None = None, name: str = "deck.pdf"):
    return client.post(
        f"/conversations/{conversation.id}/slides/decks",
        files={"file": (name, pdf or make_pdf(), "application/pdf")},
    )


def change(client: TestClient, conversation: Conversation, add: list[str] = (), remove: list[str] = ()):
    return client.patch(
        f"/conversations/{conversation.id}/slides", json={"add": list(add), "remove": list(remove)}
    )


def ids_of(body: dict, *pages: int, included: bool | None = None) -> list[str]:
    """Slide ids of the given 1-based page numbers (in the first deck)."""
    by_page = {s["page_number"]: s["id"] for s in body["slides"] if included is None or s["included"] is included}
    return [by_page[p] for p in pages]


def slide(body: dict, page: int) -> dict:
    return next(s for s in body["slides"] if s["page_number"] == page)


class TestUploadDeck:
    def test_keeps_every_page_and_puts_none_in_the_notes(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)

        response = upload(client, conversation)

        assert response.status_code == 200
        body = response.json()
        assert [s["page_number"] for s in body["slides"]] == [1, 2, 3, 4]
        assert not any(s["included"] for s in body["slides"])
        assert {s["deck_name"] for s in body["slides"]} == {"deck.pdf"}
        assert body["note_content"] == NOTES, "an upload alone leaves the notes exactly as they were"
        assert db.query(Slide).count() == 4
        deck = db.query(SlideDeck).one()
        assert deck.page_count == 4 and body["deck_id"] == str(deck.id)

    def test_calls_no_model_and_renders_no_full_size_images(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        upload(client, conversation)
        assert placer.calls == []
        assert all(s.image is None for s in db.query(Slide).all())

    def test_keeps_the_pdf_itself_for_rendering_later(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        pdf = make_pdf(3)
        upload(client, conversation, pdf)
        assert db.query(SlideDeck).one().pdf == pdf

    def test_a_second_upload_is_a_second_deck_after_the_first(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        first = upload(client, conversation, make_pdf(2), "one.pdf").json()
        second = upload(client, conversation, make_pdf(3), "two.pdf").json()
        assert second["deck_id"] != first["deck_id"]
        assert [(s["deck_name"], s["page_number"]) for s in second["slides"]] == [
            ("one.pdf", 1),
            ("one.pdf", 2),
            ("two.pdf", 1),
            ("two.pdf", 2),
            ("two.pdf", 3),
        ]
        assert db.query(SlideDeck).count() == 2

    def test_a_path_in_the_filename_is_stripped(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        body = upload(client, conversation, name="../../etc/Lecture 4.pdf").json()
        assert body["slides"][0]["deck_name"] == "Lecture 4.pdf"

    def test_refused_until_notes_exist(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db, note=None)
        assert upload(client, conversation).status_code == 409
        assert db.query(SlideDeck).count() == 0

    def test_non_pdf_is_a_400_and_keeps_nothing(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        assert upload(client, conversation, b"not a pdf").status_code == 400
        assert db.query(SlideDeck).count() == 0 and db.query(Slide).count() == 0

    def test_unknown_conversation_is_404(self, client: TestClient) -> None:
        response = client.post(
            f"/conversations/{uuid.uuid4()}/slides/decks",
            files={"file": ("deck.pdf", make_pdf(), "application/pdf")},
        )
        assert response.status_code == 404

    def test_the_conversation_reports_the_kept_pages(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        upload(client, conversation)
        detail = client.get(f"/conversations/{conversation.id}").json()
        assert detail["slide_count"] == 4, "counts every kept page, so the client knows a deck exists"
        assert detail["note_content"] == NOTES


class TestAddingPages:
    def test_only_the_ticked_pages_are_rendered_and_placed(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({2: 2, 3: 6})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()

        body = change(client, conversation, add=ids_of(deck, 2, 3)).json()

        assert [s["included"] for s in body["slides"]] == [False, True, True, False]
        assert placer.calls == [[2, 3]], "the model was asked about the two new pages, and only those"
        rows = {s.page_number: s for s in db.query(Slide).all()}
        assert rows[2].image is not None and rows[3].image is not None
        assert rows[1].image is None and rows[4].image is None, "unticked pages were never rendered"
        assert slide(body, 2)["id"] in body["note_content"] and slide(body, 3)["id"] in body["note_content"]
        assert slide(body, 1)["id"] not in body["note_content"]

    def test_the_stored_notes_stay_clean(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({1: 2})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        change(client, conversation, add=ids_of(deck, 1))
        db.refresh(conversation)
        assert "/slides/" not in conversation.note_content

    def test_adding_one_more_later_places_only_that_one(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({1: 2, 2: 6, 3: 6})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        first = change(client, conversation, add=ids_of(deck, 1, 2)).json()
        anchors_before = {s.page_number: (s.after_line, s.anchor_text) for s in db.query(Slide).filter(Slide.included)}
        placer.calls.clear()

        body = change(client, conversation, add=ids_of(first, 3)).json()

        assert placer.calls == [[3]], "the two slides already in the notes were not sent to the model again"
        anchors_after = {s.page_number: (s.after_line, s.anchor_text) for s in db.query(Slide).filter(Slide.included)}
        for page in (1, 2):
            assert anchors_after[page] == anchors_before[page], "and kept exactly the spot they had"
        assert [s["included"] for s in body["slides"]] == [True, True, True, False]

    def test_ticking_a_page_that_is_already_in_the_notes_does_nothing(
        self, client: TestClient, db: Session, placer
    ) -> None:
        placer.answers.update({1: 2})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        change(client, conversation, add=ids_of(deck, 1))
        placer.calls.clear()

        body = change(client, conversation, add=ids_of(deck, 1)).json()

        assert placer.calls == []
        assert slide(body, 1)["included"] is True

    def test_unknown_ids_are_ignored(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        upload(client, conversation)
        response = change(client, conversation, add=[str(uuid.uuid4())], remove=[str(uuid.uuid4())])
        assert response.status_code == 200
        assert placer.calls == []

    def test_another_conversations_pages_cannot_be_touched(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({1: 2})
        mine = make_conversation(db)
        theirs = make_conversation(db)
        their_deck = upload(client, theirs).json()

        change(client, mine, add=ids_of(their_deck, 1))

        assert db.query(Slide).filter(Slide.included).count() == 0

    def test_adding_needs_notes(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        conversation.note_content = None
        db.commit()

        assert change(client, conversation, add=ids_of(deck, 1)).status_code == 409
        assert db.query(Slide).filter(Slide.included).count() == 0

    def test_a_placement_failure_still_adds_the_page_but_hides_it(
        self, client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def boom(*args, **kwargs):
            raise RuntimeError("model down")

        monkeypatch.setattr("app.services.slides.place_slides", boom)
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()

        response = change(client, conversation, add=ids_of(deck, 1))

        assert response.status_code == 200
        body = response.json()
        assert slide(body, 1)["included"] is True and slide(body, 1)["placed"] is False
        assert slide(body, 1)["id"] not in body["note_content"] and "## Slides" not in body["note_content"]


class TestRemovingPages:
    def _with_three_in_the_notes(self, client, db, placer):
        placer.answers.update({1: 2, 2: 6, 3: 6})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        body = change(client, conversation, add=ids_of(deck, 1, 2, 3)).json()
        placer.calls.clear()
        return conversation, body

    def test_removes_only_that_page_and_runs_nothing_else(self, client: TestClient, db: Session, placer) -> None:
        conversation, body = self._with_three_in_the_notes(client, db, placer)
        anchors_before = {s.page_number: (s.after_line, s.anchor_text) for s in db.query(Slide).filter(Slide.included)}

        after = change(client, conversation, remove=ids_of(body, 2)).json()

        assert placer.calls == [], "removing a page does not ask the model anything"
        assert [s["included"] for s in after["slides"]] == [True, False, True, False]
        assert slide(after, 2)["id"] not in after["note_content"]
        assert slide(after, 1)["id"] in after["note_content"] and slide(after, 3)["id"] in after["note_content"]
        for row in db.query(Slide).filter(Slide.included):
            assert (row.after_line, row.anchor_text) == anchors_before[row.page_number], "the others kept their spot"

    def test_the_removed_page_stays_in_the_deck_with_its_thumbnail(self, client: TestClient, db: Session, placer) -> None:
        conversation, body = self._with_three_in_the_notes(client, db, placer)
        removed = ids_of(body, 2)[0]

        change(client, conversation, remove=[removed])

        assert client.get(f"/slides/{removed}/thumbnail").status_code == 200
        assert client.get(f"/slides/{removed}/image").status_code == 404, "no full-size image while it is out"
        assert removed in [s["id"] for s in client.get(f"/conversations/{conversation.id}/slides").json()]

    def test_it_can_be_added_back_without_uploading_the_pdf_again(self, client: TestClient, db: Session, placer) -> None:
        conversation, body = self._with_three_in_the_notes(client, db, placer)
        removed = ids_of(body, 2)
        change(client, conversation, remove=removed)
        placer.answers[2] = 6

        again = change(client, conversation, add=removed).json()

        assert placer.calls == [[2]], "only the page that came back is placed"
        assert slide(again, 2)["included"] is True and slide(again, 2)["id"] in again["note_content"]
        assert client.get(f"/slides/{removed[0]}/image").status_code == 200, "re-rendered from the kept PDF"
        assert db.query(SlideDeck).count() == 1

    def test_removing_needs_no_notes(self, client: TestClient, db: Session, placer) -> None:
        conversation, body = self._with_three_in_the_notes(client, db, placer)
        conversation.note_content = None
        db.commit()
        assert change(client, conversation, remove=ids_of(body, 1)).status_code == 200

    def test_removing_and_adding_in_one_request(self, client: TestClient, db: Session, placer) -> None:
        conversation, body = self._with_three_in_the_notes(client, db, placer)
        placer.answers[4] = 6

        after = change(client, conversation, add=ids_of(body, 4), remove=ids_of(body, 1)).json()

        assert [s["included"] for s in after["slides"]] == [False, True, True, True]
        assert placer.calls == [[4]]

    def test_an_early_slide_whose_pdf_was_never_kept_is_deleted_when_removed(
        self, client: TestClient, db: Session, placer
    ) -> None:
        # Stored before decks were kept: no deck, and it was always in the notes.
        conversation = make_conversation(db)
        legacy = Slide(
            conversation_id=conversation.id,
            position=1,
            page_number=1,
            image=b"\x89PNG-legacy",
            image_type="image/png",
            thumbnail=b"\xff\xd8-legacy",
            text="old slide",
            after_line=2,
            anchor_text="A vector has magnitude and direction.",
            included=True,
        )
        db.add(legacy)
        db.commit()
        listed = client.get(f"/conversations/{conversation.id}/slides").json()
        assert listed[0]["deck_id"] is None and listed[0]["included"] is True

        change(client, conversation, remove=[str(legacy.id)])

        assert db.query(Slide).count() == 0, "nothing to keep it from, so it is gone"


class TestDeleteDeck:
    def test_removes_the_pdf_its_pages_and_their_images_from_the_notes(
        self, client: TestClient, db: Session, placer
    ) -> None:
        placer.answers.update({1: 2})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        change(client, conversation, add=ids_of(deck, 1))

        body = client.delete(f"/conversations/{conversation.id}/slides/decks/{deck['deck_id']}").json()

        assert body["slides"] == [] and body["note_content"] == NOTES
        assert db.query(SlideDeck).count() == 0 and db.query(Slide).count() == 0

    def test_leaves_the_other_deck_alone(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        first = upload(client, conversation, make_pdf(2), "one.pdf").json()
        second = upload(client, conversation, make_pdf(3), "two.pdf").json()

        body = client.delete(f"/conversations/{conversation.id}/slides/decks/{first['deck_id']}").json()

        assert {s["deck_name"] for s in body["slides"]} == {"two.pdf"}
        assert db.query(SlideDeck).one().id == uuid.UUID(second["deck_id"])

    def test_unknown_deck_is_404(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        assert client.delete(f"/conversations/{conversation.id}/slides/decks/{uuid.uuid4()}").status_code == 404

    def test_another_conversations_deck_is_404(self, client: TestClient, db: Session, placer) -> None:
        mine = make_conversation(db)
        theirs = make_conversation(db)
        their_deck = upload(client, theirs).json()
        assert client.delete(f"/conversations/{mine.id}/slides/decks/{their_deck['deck_id']}").status_code == 404
        assert db.query(SlideDeck).count() == 1

    def test_deleting_the_conversation_deletes_its_decks_and_slides(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        upload(client, conversation)
        assert client.delete(f"/conversations/{conversation.id}").status_code == 204
        assert db.query(SlideDeck).count() == 0 and db.query(Slide).count() == 0


class TestImages:
    def test_included_pages_serve_image_and_thumbnail_with_long_cache_headers(
        self, client: TestClient, db: Session, placer
    ) -> None:
        placer.answers.update({1: 2})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        slide_id = ids_of(change(client, conversation, add=ids_of(deck, 1)).json(), 1)[0]

        image = client.get(f"/slides/{slide_id}/image")
        assert image.status_code == 200
        assert image.headers["content-type"] in ("image/png", "image/jpeg")
        assert "immutable" in image.headers["cache-control"]
        assert len(image.content) > 100

        thumb = client.get(f"/slides/{slide_id}/thumbnail")
        assert thumb.headers["content-type"] == "image/jpeg"

    def test_every_page_has_a_thumbnail_the_moment_it_is_uploaded(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        for s in deck["slides"]:
            assert client.get(f"/slides/{s['id']}/thumbnail").status_code == 200

    def test_a_page_not_in_the_notes_has_no_full_size_image(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        assert client.get(f"/slides/{deck['slides'][0]['id']}/image").status_code == 404

    def test_etag_revalidation_returns_304(self, client: TestClient, db: Session, placer) -> None:
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        sid = deck["slides"][0]["id"]
        etag = client.get(f"/slides/{sid}/thumbnail").headers["etag"]
        assert client.get(f"/slides/{sid}/thumbnail", headers={"If-None-Match": etag}).status_code == 304

    def test_unknown_slide_is_404(self, client: TestClient) -> None:
        assert client.get(f"/slides/{uuid.uuid4()}/image").status_code == 404
        assert client.get(f"/slides/{uuid.uuid4()}/thumbnail").status_code == 404


class TestUnplacedSlidesAreHidden:
    def test_the_api_reports_which_included_slides_are_placed(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({1: 2})  # page 2 gets no spot
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()

        body = change(client, conversation, add=ids_of(deck, 1, 2)).json()

        assert [(s["included"], s["placed"]) for s in body["slides"][:3]] == [(True, True), (True, False), (False, False)]
        listed = client.get(f"/conversations/{conversation.id}/slides").json()
        assert [s["placed"] for s in listed[:2]] == [True, False]

    def test_only_placed_slides_are_in_the_notes(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({1: 2})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()

        body = change(client, conversation, add=ids_of(deck, 1, 2)).json()

        assert slide(body, 1)["id"] in body["note_content"]
        assert slide(body, 2)["id"] not in body["note_content"]
        assert "## Slides" not in body["note_content"]


class TestTurnsKeepSlidesPlaced:
    @pytest.fixture
    def writer(self, monkeypatch: pytest.MonkeyPatch):
        """Stubs generate_response to return whatever notes the test sets."""
        state = {"note": NOTES, "updated": True}

        async def fake_generate_response(
            transcript, history, current_note, current_title, settings, db, project_id=None
        ):
            return TurnResult(
                note_content=state["note"],
                chat_reply="ok",
                title="Vectors",
                notes_updated=state["updated"],
                decision_reason="test",
            )

        monkeypatch.setattr("app.api.conversations.generate_response", fake_generate_response)
        return state

    def _send(self, client: TestClient, conversation: Conversation) -> dict:
        response = client.post(f"/conversations/{conversation.id}/messages", data={"transcript": "more lecture"})
        assert response.status_code == 200
        return response.json()

    def _one_in_the_notes(self, client, db, placer):
        placer.answers.update({1: 6})  # after "The dot product is a scalar."
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        body = change(client, conversation, add=ids_of(deck, 1)).json()
        placer.calls.clear()
        return conversation, ids_of(body, 1)[0]

    def test_untouched_anchor_survives_a_rewrite_without_calling_the_model(
        self, client: TestClient, db: Session, placer, writer
    ) -> None:
        conversation, slide_id = self._one_in_the_notes(client, db, placer)

        # The writer inserts a whole new section above the anchor.
        writer["note"] = NOTES.replace("## Dot product", "## Norms\n\nThe norm is a length.\n\n## Dot product")
        body = self._send(client, conversation)

        assert placer.calls == [], "anchor still exists, so no placement call"
        lines = body["note_content"].split("\n")
        assert next(i for i, l in enumerate(lines) if slide_id in l) > lines.index("The dot product is a scalar.")
        assert body["slide_count"] == 4

    def test_pages_that_are_not_in_the_notes_are_never_sent_to_the_model(
        self, client: TestClient, db: Session, placer, writer
    ) -> None:
        conversation, _ = self._one_in_the_notes(client, db, placer)

        writer["note"] = NOTES.replace("is a scalar.", "yields a single number.")
        placer.answers[1] = 2
        self._send(client, conversation)

        assert placer.calls == [[1]], "only the included slide whose anchor was lost — never the unticked pages"

    def test_reworded_anchor_is_replaced_by_the_model(self, client: TestClient, db: Session, placer, writer) -> None:
        conversation, _ = self._one_in_the_notes(client, db, placer)

        writer["note"] = NOTES.replace("is a scalar.", "yields a single number.")
        placer.answers[1] = 2  # now the model says: after the magnitude line
        body = self._send(client, conversation)

        assert placer.calls == [[1]]
        lines = body["note_content"].split("\n")
        assert next(i for i, l in enumerate(lines) if "/slides/" in l) < lines.index("## Dot product")

    def test_chat_only_turn_leaves_placement_alone(self, client: TestClient, db: Session, placer, writer) -> None:
        conversation, _ = self._one_in_the_notes(client, db, placer)

        writer["updated"] = False
        body = self._send(client, conversation)

        assert placer.calls == []
        assert "/slides/" in body["note_content"]

    def test_a_placement_failure_does_not_fail_the_turn(
        self, client: TestClient, db: Session, placer, writer, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        conversation, _ = self._one_in_the_notes(client, db, placer)

        async def boom(*args, **kwargs):
            raise RuntimeError("model down")

        monkeypatch.setattr("app.services.slides.place_slides", boom)
        writer["note"] = NOTES.replace("is a scalar.", "yields a single number.")

        body = self._send(client, conversation)

        assert "yields a single number." in body["note_content"]
        assert "/slides/" not in body["note_content"], "orphaned slide is hidden, not dumped at the end"
        assert db.query(Slide).filter(Slide.included).count() == 1, "but it is kept, to be retried"

    def test_a_hidden_slide_appears_once_a_later_notes_update_covers_it(
        self, client: TestClient, db: Session, placer, writer
    ) -> None:
        placer.answers.update({1: 2})  # page 2: no spot yet
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        hidden_id = ids_of(change(client, conversation, add=ids_of(deck, 1, 2)).json(), 2)[0]
        placer.calls.clear()

        writer["note"] = NOTES + "\n\nA new section that covers the second slide."
        placer.answers[2] = 8  # the model now finds it a spot: after the new section
        response = self._send(client, conversation)

        assert placer.calls == [[2]], "only the still-unplaced slide is retried"
        assert hidden_id in response["note_content"]

    def test_get_conversation_returns_injected_notes_and_the_total(self, client: TestClient, db: Session, placer) -> None:
        placer.answers.update({1: 2})
        conversation = make_conversation(db)
        deck = upload(client, conversation).json()
        slide_id = ids_of(change(client, conversation, add=ids_of(deck, 1)).json(), 1)[0]

        body = client.get(f"/conversations/{conversation.id}").json()

        assert body["slide_count"] == 4
        assert slide_id in body["note_content"]
