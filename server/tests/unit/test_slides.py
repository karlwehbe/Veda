"""Unit tests for the slide placement logic — the pure parts, no DB or LLM.

Slide rows are built without a session; SQLAlchemy models can be instantiated
standalone, and none of these functions touch the deferred image columns.
"""

import uuid

import pymupdf
import pytest

from app.models import Slide
from app.services.slides import (
    MAX_PAGES,
    PdfError,
    _batches,
    apply_placements,
    is_placed,
    notes_with_slides,
    read_deck,
    render_images,
    resolve_anchors,
    slide_alt,
)

NOTES = """\
# Vectors

A vector has magnitude and direction.
It is written in bold.

## Dot product

The dot product of a and b is a scalar.

## Code

```python
def dot(a, b):

    return sum(x * y for x, y in zip(a, b))
```

## Math

$$
a \\cdot b = |a||b|\\cos\\theta
$$

| a | b |
|---|---|
| 1 | 2 |

Closing thoughts."""


def make_slide(position: int, text: str = "", after_line: int | None = None, **kwargs) -> Slide:
    kwargs.setdefault("included", True)  # a column default only applies at flush time
    return Slide(
        id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
        position=position,
        page_number=position,
        text=text,
        after_line=after_line,
        image_type="image/png",
        **kwargs,
    )


def line_of(fragment: str) -> int:
    for i, line in enumerate(NOTES.split("\n")):
        if fragment in line:
            return i
    raise AssertionError(fragment)


def image_line(slide: Slide) -> str:
    return f"![{slide_alt(slide)}](/slides/{slide.id}/image)"


class TestNotesWithSlides:
    def test_no_slides_returns_notes_unchanged(self) -> None:
        assert notes_with_slides(NOTES, []) == NOTES

    def test_no_notes_returns_notes_unchanged(self) -> None:
        assert notes_with_slides(None, [make_slide(1)]) is None

    def test_inserts_after_the_end_of_the_paragraph_not_mid_paragraph(self) -> None:
        slide = make_slide(1, "Vectors", after_line=line_of("magnitude"))
        out = notes_with_slides(NOTES, [slide]).split("\n")
        i = out.index(image_line(slide))
        assert out[i - 2] == "It is written in bold."
        assert out[i - 1] == ""

    def test_never_lands_inside_a_code_fence(self) -> None:
        slide = make_slide(1, "Dot", after_line=line_of("return sum"))
        out = notes_with_slides(NOTES, [slide]).split("\n")
        assert out.index(image_line(slide)) > out.index("```", out.index("```python") + 1)

    def test_a_blank_line_inside_a_fence_does_not_end_the_block(self) -> None:
        slide = make_slide(1, "Dot", after_line=line_of("def dot"))
        out = notes_with_slides(NOTES, [slide]).split("\n")
        assert out.index(image_line(slide)) > out.index("    return sum(x * y for x, y in zip(a, b))")

    def test_never_lands_inside_a_math_block(self) -> None:
        slide = make_slide(1, "Cos", after_line=line_of("cos"))
        out = notes_with_slides(NOTES, [slide]).split("\n")
        opening = out.index("$$")
        closing = out.index("$$", opening + 1)
        assert out.index(image_line(slide)) > closing

    def test_never_lands_inside_a_table(self) -> None:
        slide = make_slide(1, "Table", after_line=line_of("|---|"))
        out = notes_with_slides(NOTES, [slide]).split("\n")
        assert out.index(image_line(slide)) > out.index("| 1 | 2 |")

    def test_several_slides_at_one_spot_keep_deck_order(self) -> None:
        a = make_slide(2, "Second", after_line=line_of("scalar"))
        b = make_slide(1, "First", after_line=line_of("scalar"))
        out = notes_with_slides(NOTES, [a, b]).split("\n")
        assert out.index(image_line(b)) < out.index(image_line(a))

    def test_unplaced_and_out_of_range_slides_are_hidden(self) -> None:
        unplaced = make_slide(1, "Agenda")
        out_of_range = make_slide(2, "Old", after_line=10_000)
        # Nothing placed at all: the notes come back untouched, with no
        # "Slides" section collecting the leftovers.
        assert notes_with_slides(NOTES, [unplaced, out_of_range]) == NOTES

    def test_hidden_slides_do_not_disturb_the_placed_ones(self) -> None:
        placed = make_slide(1, "Vectors", after_line=line_of("scalar"))
        hidden = make_slide(2, "Agenda")
        out = notes_with_slides(NOTES, [placed, hidden])
        assert image_line(placed) in out.split("\n")
        assert str(hidden.id) not in out
        assert "## Slides" not in out

    def test_the_stored_notes_are_not_mutated(self) -> None:
        before = NOTES
        notes_with_slides(NOTES, [make_slide(1, "x", after_line=2)])
        assert NOTES == before

    def test_alt_text_cannot_break_the_markdown(self) -> None:
        slide = make_slide(1, "Bad [alt](x) $y$ `z`\nsecond line")
        assert slide_alt(slide) == "Bad altx y z"

    def test_alt_falls_back_to_the_page_number(self) -> None:
        assert slide_alt(make_slide(3, "")) == "Slide 3"


class TestIsPlaced:
    def test_needs_a_line_inside_the_notes(self) -> None:
        assert not is_placed(make_slide(1), 10)  # never placed
        assert not is_placed(make_slide(1, after_line=-1), 10)
        assert is_placed(make_slide(1, after_line=0), 10)
        assert is_placed(make_slide(1, after_line=9), 10)
        assert not is_placed(make_slide(1, after_line=10), 10)  # one past the end
        assert not is_placed(make_slide(1, after_line=0), 0)  # no notes at all


class TestResolveAnchors:
    def _placed(self, position: int, fragment: str) -> Slide:
        slide = make_slide(position, "t")
        apply_placements(NOTES, [slide], {position: line_of(fragment)})
        return slide

    def test_apply_records_the_line_text_and_heading(self) -> None:
        slide = self._placed(1, "scalar")
        assert slide.anchor_text == "The dot product of a and b is a scalar."
        assert slide.anchor_heading == "## Dot product"
        assert slide.after_line == line_of("scalar")

    def test_a_blank_line_choice_snaps_up_to_text(self) -> None:
        slide = make_slide(1, "t")
        apply_placements(NOTES, [slide], {1: line_of("scalar") + 1})
        assert slide.anchor_text == "The dot product of a and b is a scalar."

    def test_null_placement_leaves_it_unplaced(self) -> None:
        slide = make_slide(1, "t", after_line=3, anchor_text="x")
        apply_placements(NOTES, [slide], {1: None})
        assert slide.after_line is None and slide.anchor_text is None

    def test_unchanged_line_is_kept_and_reindexed_after_lines_are_added_above(self) -> None:
        slide = self._placed(1, "scalar")
        rewritten = "# Intro\n\nNew opening paragraph.\n\n" + NOTES
        assert resolve_anchors(rewritten, [slide]) == []
        assert slide.after_line == rewritten.split("\n").index("The dot product of a and b is a scalar.")

    def test_reworded_line_orphans_the_slide(self) -> None:
        slide = self._placed(1, "scalar")
        rewritten = NOTES.replace("is a scalar.", "yields a single number.")
        assert resolve_anchors(rewritten, [slide]) == [slide]
        assert slide.after_line is None

    def test_never_placed_slide_is_an_orphan(self) -> None:
        slide = make_slide(1, "t")
        assert resolve_anchors(NOTES, [slide]) == [slide]

    def test_repeated_line_prefers_the_occurrence_under_the_same_heading(self) -> None:
        notes = "# A\n\nExample:\n\n# B\n\nExample:\n\nend"
        slide = make_slide(1, "t", anchor_text="Example:", anchor_heading="# B")
        resolve_anchors(notes, [slide])
        assert slide.after_line == 6


class TestBatches:
    def test_slides_are_capped_per_call(self) -> None:
        slides = [make_slide(i, "x" * 100) for i in range(45)]
        assert [len(b) for b in _batches(slides)] == [20, 20, 5]

    def test_image_only_slides_are_capped_per_call(self) -> None:
        slides = [make_slide(i, "") for i in range(20)]
        assert [len(b) for b in _batches(slides)] == [8, 8, 4]


def _pdf(pages: int) -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 60), f"Slide title {i + 1}\nSome body text")
    data = doc.tobytes()
    doc.close()
    return data


class TestIncludedFilter:
    def test_pages_not_in_the_notes_are_never_rendered_into_them(self) -> None:
        kept = make_slide(1, "Vectors", after_line=line_of("scalar"))
        left_out = make_slide(2, "Other", after_line=line_of("scalar"), included=False)
        out = notes_with_slides(NOTES, [kept, left_out])
        assert image_line(kept) in out.split("\n")
        assert str(left_out.id) not in out

    def test_a_deck_with_nothing_included_leaves_the_notes_untouched(self) -> None:
        pages = [make_slide(i, "x", after_line=2, included=False) for i in (1, 2, 3)]
        assert notes_with_slides(NOTES, pages) == NOTES


class TestPdfRendering:
    def test_a_thumbnail_and_the_text_of_every_page(self) -> None:
        pages = read_deck(_pdf(3))
        assert [p.page_number for p in pages] == [1, 2, 3]
        assert all(p.thumbnail.startswith(b"\xff\xd8") for p in pages), "thumbnails are JPEG"
        assert "Slide title 2" in pages[1].text

    def test_reading_a_deck_does_not_render_full_size_images(self) -> None:
        # The heavy work waits until a page is added to the notes.
        assert not hasattr(read_deck(_pdf(1))[0], "image")

    def test_only_the_asked_for_pages_are_rendered_full_size(self) -> None:
        rendered = render_images(_pdf(5), [2, 4])
        assert [r.page_number for r in rendered] == [2, 4]
        assert rendered[0].image.startswith(b"\x89PNG")
        assert rendered[0].image_type == "image/png"

    def test_page_outside_the_document_is_rejected(self) -> None:
        with pytest.raises(PdfError):
            render_images(_pdf(2), [3])

    def test_garbage_is_rejected(self) -> None:
        with pytest.raises(PdfError):
            read_deck(b"this is not a pdf")

    def test_too_many_pages_is_rejected(self) -> None:
        with pytest.raises(PdfError):
            read_deck(_pdf(MAX_PAGES + 1))
