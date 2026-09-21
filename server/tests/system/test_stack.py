"""System tests: the assembled stack over real HTTP.

Everything here is real except the model — real containers, real Postgres,
real network, real startup (init_db has run for these tables to exist). This
is the layer that catches wiring problems the other layers cannot see: a
container serving stale code, a missing env var, CORS, schema that never
got applied.
"""

import uuid

import httpx


class TestStackHealth:
    def test_health_reports_the_database(self, api: httpx.Client) -> None:
        body = api.get("/health").json()
        assert body["status"] == "ok"
        assert body["db"] == "ok", "the API is up but cannot reach Postgres"

    def test_schema_was_applied_at_startup(self, api: httpx.Client) -> None:
        # init_db() runs in the lifespan; if it silently failed, the first
        # query would 500 rather than return an empty list.
        assert api.get("/conversations").status_code == 200

    def test_cors_allows_the_dev_origin(self, api: httpx.Client) -> None:
        response = api.options(
            "/conversations",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"

    def test_openapi_is_served(self, api: httpx.Client) -> None:
        assert api.get("/openapi.json").json()["info"]["title"] == "Veda"


class TestConversationJourney:
    def test_full_turn_persists_across_the_stack(self, api: httpx.Client, conversation: str, stub) -> None:
        response = api.post(
            f"/conversations/{conversation}/messages",
            data={"transcript": "a vector has magnitude and direction"},
        )
        assert response.status_code == 200, response.text

        body = response.json()
        assert body["user_message"]["content"] == "a vector has magnitude and direction"
        assert body["assistant_message"]["content"]
        assert body["note_content"], "no notes were written"

        # Re-fetch: proves it was committed, not just returned.
        fetched = api.get(f"/conversations/{conversation}").json()
        assert len(fetched["messages"]) == 2
        assert fetched["note_content"] == body["note_content"]

    def test_title_is_set_on_the_first_turn(self, api: httpx.Client, conversation: str, stub) -> None:
        api.post(f"/conversations/{conversation}/messages", data={"transcript": "lecture content"})
        assert api.get(f"/conversations/{conversation}").json()["title"] != "New conversation"

    def test_draft_survives_a_round_trip(self, api: httpx.Client, conversation: str) -> None:
        api.patch(f"/conversations/{conversation}/draft", json={"transcript": "mid-lecture"})
        assert api.get(f"/conversations/{conversation}").json()["draft_transcript"] == "mid-lecture"

    def test_delete_removes_it(self, api: httpx.Client) -> None:
        conversation_id = api.post("/conversations").json()["id"]
        assert api.delete(f"/conversations/{conversation_id}").status_code == 204
        assert api.get(f"/conversations/{conversation_id}").status_code == 404


class TestModelWiring:
    """Asserts on what the stack actually sent the model — the containment
    properties that keep user content away from the router's decision."""

    def test_both_graph_nodes_are_called(self, api: httpx.Client, conversation: str, stub) -> None:
        api.post(f"/conversations/{conversation}/messages", data={"transcript": "lecture content"})
        schemas = [r["schema"] for r in stub.get("/__stub/requests").json()]
        assert "RouteDecision" in schemas, "the router never ran"
        assert "NotesUpdate" in schemas, "the notes branch never ran"

    def test_router_runs_before_the_writer(self, api: httpx.Client, conversation: str, stub) -> None:
        api.post(f"/conversations/{conversation}/messages", data={"transcript": "lecture content"})
        schemas = [r["schema"] for r in stub.get("/__stub/requests").json()]
        assert schemas.index("RouteDecision") < schemas.index("NotesUpdate")

    def test_the_transcript_reaches_the_model(self, api: httpx.Client, conversation: str, stub) -> None:
        api.post(f"/conversations/{conversation}/messages", data={"transcript": "eigenvalues and eigenvectors"})
        sent = str(stub.get("/__stub/requests").json())
        assert "eigenvalues and eigenvectors" in sent

    def test_no_real_provider_was_contacted(self, api: httpx.Client, conversation: str, stub) -> None:
        # If OPENAI_BASE_URL were unset the turn would still succeed against
        # the real API and quietly cost money. The stub recording proves the
        # redirect is in effect.
        api.post(f"/conversations/{conversation}/messages", data={"transcript": "lecture content"})
        assert stub.get("/__stub/requests").json(), "nothing reached the stub — is OPENAI_BASE_URL set?"


class TestErrorHandling:
    def test_unknown_conversation_is_404(self, api: httpx.Client) -> None:
        assert api.get(f"/conversations/{uuid.uuid4()}").status_code == 404

    def test_malformed_uuid_is_422(self, api: httpx.Client) -> None:
        assert api.get("/conversations/not-a-uuid").status_code == 422

    def test_empty_message_is_rejected(self, api: httpx.Client, conversation: str) -> None:
        assert api.post(f"/conversations/{conversation}/messages", data={}).status_code == 400

    def test_silent_recording_is_rejected(self, api: httpx.Client, conversation: str) -> None:
        response = api.post(f"/conversations/{conversation}/messages", data={"transcript": "   "})
        assert response.status_code == 400
        assert "speech" in response.json()["detail"].lower()
