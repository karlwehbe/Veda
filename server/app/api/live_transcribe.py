import asyncio
import json
import logging

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter()

DEEPGRAM_LIVE_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-2&smart_format=true&interim_results=true"
)


async def _relay_client_to_deepgram(client_ws: WebSocket, dg_ws) -> None:
    try:
        while True:
            chunk = await client_ws.receive_bytes()
            await dg_ws.send(chunk)
    except WebSocketDisconnect:
        pass
    finally:
        # Tells Deepgram no more audio is coming, so it flushes a final result.
        try:
            await dg_ws.send(json.dumps({"type": "CloseStream"}))
        except Exception:
            pass


async def _relay_deepgram_to_client(dg_ws, client_ws: WebSocket) -> None:
    async for message in dg_ws:
        data = json.loads(message)
        transcript = (
            data.get("channel", {}).get("alternatives", [{}])[0].get("transcript", "")
        )
        if transcript:
            await client_ws.send_json({"transcript": transcript, "is_final": data.get("is_final", False)})


@router.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket, conversation_id: str | None = None) -> None:
    """Proxies mic/system audio from the client to Deepgram's live streaming
    API and relays transcripts back — keeps the Deepgram API key server-side
    instead of exposing it to the browser, which a direct client connection
    to Deepgram would require.

    conversation_id is passed by the client purely for logging — it's known
    client-side by the time this connects (recording eagerly creates the
    conversation before opening this socket), and tagging every line with it
    is what makes a whole recording traceable end to end alongside the
    /messages request it eventually feeds into.
    """
    tag = f"[{conversation_id}]" if conversation_id else "[no conversation id]"
    await websocket.accept()
    logger.info("%s live transcription session started", tag)
    settings = get_settings()

    if not settings.deepgram_api_key:
        logger.warning("%s transcription not configured (missing Deepgram API key)", tag)
        await websocket.close(code=1011, reason="Transcription isn't available right now.")
        return

    try:
        async with websockets.connect(
            DEEPGRAM_LIVE_URL,
            additional_headers={"Authorization": f"Token {settings.deepgram_api_key}"},
        ) as dg_ws:
            logger.info("%s connected to Deepgram", tag)
            deepgram_task = asyncio.create_task(_relay_deepgram_to_client(dg_ws, websocket))
            try:
                # Runs until the client disconnects — its finally block sends
                # CloseStream, telling Deepgram to flush whatever it's still
                # finalizing (e.g. the last utterance, if it hadn't already
                # been finalized by natural endpointing).
                await _relay_client_to_deepgram(websocket, dg_ws)
            finally:
                # Give deepgram_task a chance to receive and relay that
                # flushed result before tearing down — cancelling it
                # immediately here (the previous approach, racing both tasks
                # with FIRST_COMPLETED) was dropping it: client_task finishing
                # right after sending CloseStream would win the race and the
                # pending deepgram_task got cancelled before Deepgram's flushed
                # final ever arrived. It normally closes on its own within a
                # second of CloseStream; the timeout is just a safety net.
                try:
                    await asyncio.wait_for(deepgram_task, timeout=5.0)
                except TimeoutError:
                    logger.warning("%s Deepgram relay didn't close in time, cancelling", tag)
                except Exception:
                    pass
    except Exception:
        logger.exception("%s live transcription proxy failed", tag)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("%s live transcription session ended", tag)
