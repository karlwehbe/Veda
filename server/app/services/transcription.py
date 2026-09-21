import logging

import httpx
from fastapi import HTTPException, status

from app.config import Settings

logger = logging.getLogger(__name__)

DEEPGRAM_TRANSCRIPTION_URL = "https://api.deepgram.com/v1/listen"


async def transcribe_audio(audio_bytes: bytes, settings: Settings) -> str:
    if not settings.deepgram_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Transcription isn't available right now. Please try again later.",
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            DEEPGRAM_TRANSCRIPTION_URL,
            headers={
                "Authorization": f"Token {settings.deepgram_api_key}",
                "Content-Type": "application/octet-stream",
            },
            params={"model": "nova-2", "smart_format": "true"},
            content=audio_bytes,
        )

    if response.status_code != 200:
        # Deepgram's raw error body isn't something to show someone using the
        # app (often JSON/HTML, sometimes large) — log it for debugging and
        # surface a clean message instead.
        logger.error("Deepgram transcription request failed (%s): %s", response.status_code, response.text)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Transcription failed. Please try again.",
        )

    data = response.json()
    try:
        return data["results"]["channels"][0]["alternatives"][0]["transcript"].strip()
    except (KeyError, IndexError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Transcription failed. Please try again.",
        ) from exc
