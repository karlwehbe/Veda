import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import conversations, health, live_transcribe, profile, projects
from app.config import get_settings
from app.db import init_db

# The app previously had no logging configuration at all, so app.* loggers
# (conversations.py, live_transcribe.py, transcription.py, notes_graph.py)
# fell back to the root logger's default — WARNING level, no formatting —
# meaning most of what those modules log never appeared anywhere. This makes
# them all visible via `docker compose logs -f api`, one line per workflow
# step, tagged with which module logged it.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Da Vinci", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(conversations.router)
    app.include_router(live_transcribe.router)
    app.include_router(profile.router)
    app.include_router(projects.router)

    return app


app = create_app()
