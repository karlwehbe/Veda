from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    # No migration tool for this small portfolio build — tables are created
    # directly from the models at startup if they don't already exist.
    # create_all does NOT add new columns to existing tables, so we also
    # apply a tiny set of additive ALTERs for columns that landed after the
    # first create (otherwise draft saves fail silently against old DBs).
    import app.models  # noqa: F401  (registers models on Base.metadata)

    # Runs before create_all: user_profiles was restructured for the personal
    # context layer (flat columns -> a jsonb `fields` blob, since two answers
    # are multi-select; profile_guidance -> nullable compiled_prompt; plus
    # is_edited). The old shape only ever held throwaway data, so it's dropped
    # and recreated rather than migrated column by column.
    with engine.begin() as conn:
        if conn.execute(text("SELECT to_regclass('public.user_profiles')")).scalar():
            legacy = conn.execute(
                text(
                    "SELECT 1 FROM information_schema.columns "
                    "WHERE table_name = 'user_profiles' AND column_name = 'profile_guidance'"
                )
            ).scalar()
            if legacy:
                conn.execute(text("DROP TABLE user_profiles"))

        # "Upload my notes" / notes_style_samples was removed end-to-end.
        # Drop leftover table + the old prompt_sections mirror if present.
        conn.execute(text("DROP TABLE IF EXISTS notes_style_samples"))
        conn.execute(text("DROP TABLE IF EXISTS prompt_sections"))

    Base.metadata.create_all(bind=engine)

    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE user_profiles "
                "ADD COLUMN IF NOT EXISTS compile_failed_at TIMESTAMPTZ"
            )
        )

        conn.execute(
            text(
                "ALTER TABLE conversations "
                "ADD COLUMN IF NOT EXISTS draft_transcript TEXT"
            )
        )

        # is_edited existed only to guard a hand-edited compiled prompt. The
        # compiled description is private now — there is nothing for the user
        # to edit, so nothing to protect.
        conn.execute(
            text("ALTER TABLE user_profiles DROP COLUMN IF EXISTS is_edited")
        )

        # projects is a wholly new table, created by create_all() above —
        # this is only the added column + FK on the pre-existing
        # conversations table. References projects(id), so it has to run
        # after create_all has had a chance to create that table.
        conn.execute(
            text(
                "ALTER TABLE conversations "
                "ADD COLUMN IF NOT EXISTS project_id UUID "
                "REFERENCES projects(id) ON DELETE CASCADE"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_conversations_project_id "
                "ON conversations (project_id)"
            )
        )

        # The FK above was first shipped as ON DELETE SET NULL (deleting a
        # project orphaned its conversations). Changed to ON DELETE CASCADE —
        # deleting a project now deletes its conversations too. ADD COLUMN IF
        # NOT EXISTS is a no-op on a column that already exists, so it never
        # picks up that change on an already-migrated database; drop and
        # recreate the constraint explicitly. conversations_project_id_fkey is
        # Postgres's own default name for a single-statement ALTER TABLE ADD
        # COLUMN ... REFERENCES, which is how this FK has only ever been
        # created — never hand-named — so the literal name is safe to assume.
        conn.execute(
            text(
                "ALTER TABLE conversations "
                "DROP CONSTRAINT IF EXISTS conversations_project_id_fkey"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE conversations "
                "ADD CONSTRAINT conversations_project_id_fkey "
                "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
            )
        )

        conn.execute(
            text(
                "ALTER TABLE projects "
                "ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''"
            )
        )

        # Slide decks are kept now (see models/slide_deck.py). slide_decks is a
        # wholly new table, made by create_all() above; these are the columns
        # added to the pre-existing slides table. Slides stored before this
        # have no deck (their PDF was never kept) and were all in the notes,
        # hence the defaults.
        conn.execute(
            text(
                "ALTER TABLE slides "
                "ADD COLUMN IF NOT EXISTS deck_id UUID REFERENCES slide_decks(id) ON DELETE CASCADE"
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_slides_deck_id ON slides (deck_id)"))
        conn.execute(
            text("ALTER TABLE slides ADD COLUMN IF NOT EXISTS included BOOLEAN NOT NULL DEFAULT TRUE")
        )
        # A page that isn't in the notes has no full-size render.
        conn.execute(text("ALTER TABLE slides ALTER COLUMN image DROP NOT NULL"))

        # draft_transcript's replacement: the draft is now a sequence of small
        # appended rows (draft_chunks, a wholly new table created by create_all()
        # above) instead of one column rewritten in full on every autosave — see
        # models/draft_chunk.py. The old column only ever held disposable
        # autosave scratch (never a durable record of anything), so it's dropped
        # rather than migrated.
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_draft_chunks_conversation_id "
                "ON draft_chunks (conversation_id, id)"
            )
        )
        conn.execute(text("ALTER TABLE conversations DROP COLUMN IF EXISTS draft_transcript"))


def check_db_connection() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
