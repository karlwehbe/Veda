"""Integration tests: the projects API against a real Postgres.

A project is a flat folder grouping conversations — no nesting, and a
conversation belongs to at most one. Deleting a project cascade-deletes the
conversations filed under it, and their notes and messages with them —
ON DELETE CASCADE, chained through each conversation's own CASCADE to its
messages (see Conversation.project_id in models/conversation.py).
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Conversation, Message, Project

PROJECT = {
    "name": "Linear Algebra",
    "type": "Course",
    "description": "Second-year linear algebra, taught by Prof. Okafor.",
    "instructions": "Use British spelling and cite the textbook chapter.",
}


def _make_project(db: Session, **kwargs) -> Project:
    project = Project(**{**PROJECT, **kwargs})
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_conversation(db: Session, **kwargs) -> Conversation:
    conversation = Conversation(**kwargs)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


class TestProjectCrud:
    def test_create_round_trips_every_field(self, client: TestClient) -> None:
        response = client.post("/projects", json=PROJECT)
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == PROJECT["name"]
        assert body["type"] == PROJECT["type"]
        assert body["description"] == PROJECT["description"]
        assert body["instructions"] == PROJECT["instructions"]
        assert body["conversation_count"] == 0

    def test_list_is_empty_to_start(self, client: TestClient) -> None:
        assert client.get("/projects").json() == []

    def test_list_is_sorted_newest_first(self, client: TestClient) -> None:
        first = client.post("/projects", json={**PROJECT, "name": "First"}).json()
        second = client.post("/projects", json={**PROJECT, "name": "Second"}).json()
        assert [p["id"] for p in client.get("/projects").json()] == [second["id"], first["id"]]

    def test_get_missing_project_is_404(self, client: TestClient) -> None:
        assert client.get(f"/projects/{uuid.uuid4()}").status_code == 404

    def test_update_replaces_the_fields(self, client: TestClient, db: Session) -> None:
        project = _make_project(db)
        response = client.put(f"/projects/{project.id}", json={**PROJECT, "name": "Renamed"})
        assert response.status_code == 200
        assert response.json()["name"] == "Renamed"

    def test_over_long_instructions_are_rejected(self, client: TestClient) -> None:
        payload = {**PROJECT, "instructions": "x" * 700}
        assert client.post("/projects", json=payload).status_code == 422


class TestProjectConversations:
    def test_detail_lists_its_conversations(self, client: TestClient, db: Session) -> None:
        project = _make_project(db)
        _make_conversation(db, project_id=project.id, title="Week 1")
        _make_conversation(db, project_id=project.id, title="Week 2")
        _make_conversation(db)  # ungrouped — must not appear

        body = client.get(f"/projects/{project.id}").json()
        assert body["conversation_count"] == 2
        assert {c["title"] for c in body["conversations"]} == {"Week 1", "Week 2"}

    def test_create_conversation_assigns_the_project(self, client: TestClient, db: Session) -> None:
        project = _make_project(db)
        response = client.post("/conversations", params={"project_id": str(project.id)})
        assert response.status_code == 200
        assert response.json()["project_id"] == str(project.id)

    def test_create_conversation_rejects_an_unknown_project(self, client: TestClient) -> None:
        response = client.post("/conversations", params={"project_id": str(uuid.uuid4())})
        assert response.status_code == 404

    def test_create_conversation_without_a_project_is_ungrouped(self, client: TestClient) -> None:
        assert client.post("/conversations").json()["project_id"] is None


class TestProjectDeletion:
    def test_delete_cascades_to_its_conversations(self, client: TestClient, db: Session) -> None:
        project = _make_project(db)
        conversation = _make_conversation(db, project_id=project.id, note_content="A vector has magnitude.")
        # Captured before the delete: the row is gone once client.delete()
        # returns, and reading .id off an ORM object whose row vanished
        # underneath it — even just to build a where() clause — triggers a
        # refresh that raises ObjectDeletedError instead of the plain UUID.
        conversation_id = conversation.id

        assert client.delete(f"/projects/{project.id}").status_code == 204

        db.expire_all()
        survivor = db.execute(select(Conversation).where(Conversation.id == conversation_id)).scalar_one_or_none()
        assert survivor is None, "the conversation survived its project's deletion"

    def test_delete_cascades_to_messages_inside_those_conversations(
        self, client: TestClient, db: Session
    ) -> None:
        project = _make_project(db)
        conversation = _make_conversation(db, project_id=project.id)
        message = Message(conversation_id=conversation.id, role="user", content="lecture")
        db.add(message)
        db.commit()
        db.refresh(message)
        message_id = message.id  # see the comment above — captured pre-delete

        assert client.delete(f"/projects/{project.id}").status_code == 204

        db.expire_all()
        survivor = db.execute(select(Message).where(Message.id == message_id)).scalar_one_or_none()
        assert survivor is None, "a message survived its conversation's cascade-deletion"

    def test_delete_leaves_conversations_outside_the_project_alone(
        self, client: TestClient, db: Session
    ) -> None:
        project = _make_project(db)
        ungrouped = _make_conversation(db)

        assert client.delete(f"/projects/{project.id}").status_code == 204

        db.expire_all()
        assert db.get(Conversation, ungrouped.id) is not None

    def test_delete_with_no_row_is_404(self, client: TestClient) -> None:
        assert client.delete(f"/projects/{uuid.uuid4()}").status_code == 404
