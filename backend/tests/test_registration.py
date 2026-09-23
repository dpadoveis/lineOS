"""Who may sign up: the first account always (it becomes the admin), then the
REGISTRATION policy -- open, invite (a live share link) or closed."""
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from conftest import PASSWORD, graph, node, register


def sign_up(c, email, invite=None):
    body = {"name": "Someone", "email": email, "password": PASSWORD}
    if invite is not None:
        body["invite"] = invite
    return c.post("/api/auth/register", json=body)


@pytest.fixture
def policy(monkeypatch):
    def set_to(value):
        monkeypatch.setattr(settings, "registration", value)
    return set_to


def owner_with_link(c):
    """The admin, signed in, with one diagram and a live link to it."""
    register(c, "admin@example.test", "Admin")
    flow = c.post("/api/flows", json={"name": "D", "graph": graph(nodes=[node(1)], edges=[])}).json()
    link = c.post(f"/api/shares/{flow['id']}/links", json={"permission": "view"}).json()
    return flow, link


def test_an_empty_server_reports_first_run_and_the_first_account_is_admin(anonymous_client, policy):
    policy("closed")
    c = anonymous_client
    assert c.get("/api/auth/me").json()["registration"] == "first_run"
    r = sign_up(c, "admin@example.test")
    assert r.status_code == 201, r.text
    assert r.json()["user"]["is_admin"] is True
    assert r.json()["registration"] == "closed"


def test_later_accounts_are_not_admin(anonymous_client, policy):
    policy("open")
    register(anonymous_client, "admin@example.test")
    with TestClient(app) as other:
        r = sign_up(other, "bob@example.test")
        assert r.status_code == 201
        assert r.json()["user"]["is_admin"] is False


def test_closed_refuses_everyone_after_the_first(anonymous_client, policy):
    policy("closed")
    _, link = owner_with_link(anonymous_client)
    with TestClient(app) as other:
        assert other.get("/api/auth/me").json()["registration"] == "closed"
        assert sign_up(other, "bob@example.test", invite=link["token"]).status_code == 403


def test_invite_needs_a_live_share_link(anonymous_client, policy):
    policy("invite")
    flow, link = owner_with_link(anonymous_client)
    with TestClient(app) as other:
        assert other.get("/api/auth/me").json()["registration"] == "invite"
        assert sign_up(other, "bob@example.test").status_code == 403
        assert sign_up(other, "bob@example.test", invite="not-a-token").status_code == 403
        r = sign_up(other, "bob@example.test", invite=link["token"])
        assert r.status_code == 201, r.text

    anonymous_client.delete(f"/api/shares/{flow['id']}/links/{link['id']}")
    with TestClient(app) as late:
        assert sign_up(late, "carol@example.test", invite=link["token"]).status_code == 403


def test_open_lets_anyone_in(anonymous_client, policy):
    policy("open")
    register(anonymous_client, "admin@example.test")
    with TestClient(app) as other:
        assert sign_up(other, "bob@example.test").status_code == 201
