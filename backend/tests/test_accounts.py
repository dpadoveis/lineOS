"""Accounts, permissions and sharing."""
from conftest import PASSWORD, graph, node, register  # noqa: E402


def create_flow(c, name="Diagram"):
    r = c.post("/api/flows", json={"name": name, "graph": graph(nodes=[node(1)], edges=[])})
    assert r.status_code == 201, r.text
    return r.json()


# ── Sign-up and session ──────────────────────────────────────────────


def test_signing_up_opens_a_session_and_me_answers(anonymous_client):
    c = anonymous_client
    assert c.get("/api/auth/me").json()["user"] is None

    user = register(c, "ana@example.test", "Ana")
    assert user["email"] == "ana@example.test"
    assert c.get("/api/auth/me").json()["user"]["id"] == user["id"]

    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").json()["user"] is None


def test_duplicate_email_is_refused(anonymous_client):
    c = anonymous_client
    register(c, "ana@example.test")
    r = c.post(
        "/api/auth/register",
        json={"name": "Outra", "email": "ANA@example.test", "password": PASSWORD},
    )
    # The email is lowercased on the way in: capitals do not open a second account.
    assert r.status_code == 409


def test_login_fails_without_saying_which_field_was_wrong(anonymous_client):
    c = anonymous_client
    register(c, "ana@example.test")
    c.post("/api/auth/logout")
    no_account = c.post("/api/auth/login", json={"email": "zzz@example.test", "password": PASSWORD})
    wrong_password = c.post("/api/auth/login", json={"email": "ana@example.test", "password": "outra-senha"})
    assert no_account.status_code == wrong_password.status_code == 401
    assert no_account.json()["detail"] == wrong_password.json()["detail"]

    ok = c.post("/api/auth/login", json={"email": "ana@example.test", "password": PASSWORD})
    assert ok.status_code == 200 and ok.json()["user"]["name"] == "Owner"


def test_short_password_is_refused(anonymous_client):
    r = anonymous_client.post(
        "/api/auth/register", json={"name": "Ana", "email": "ana@example.test", "password": "1234"}
    )
    assert r.status_code == 422


def test_the_flows_api_needs_an_account(anonymous_client):
    assert anonymous_client.get("/api/flows").status_code == 401


# ── Ownership ────────────────────────────────────────────────────────


def test_another_users_flow_neither_lists_nor_opens(client, anonymous_client):
    flow = create_flow(client, "Mine alone")

    other = anonymous_client
    register(other, "bob@example.test", "Bob")
    assert other.get("/api/flows").json() == []
    # 404, not 403: "it exists, but is not yours" would leak that the flow exists.
    assert other.get(f"/api/flows/{flow['id']}").status_code == 404


def test_the_listing_carries_owner_and_permission(client):
    create_flow(client, "Meu")
    item = client.get("/api/flows").json()[0]
    assert item["permission"] == "full"
    assert item["is_owner"] is True
    assert item["owner_name"] == "Owner"


def test_the_homepage_limit(client):
    for i in range(4):
        create_flow(client, f"Diagrama {i}")
    assert len(client.get("/api/flows?limit=2").json()) == 2


# ── Sharing with a user ──────────────────────────────────────────────


def share_with(owner, flow_id, email, permission):
    return owner.post(
        f"/api/shares/{flow_id}/users", json={"email": email, "permission": permission}
    )


def test_share_view_reads_but_does_not_write(client, anonymous_client):
    flow = create_flow(client)
    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")

    assert share_with(client, flow["id"], "bob@example.test", "view").status_code == 201

    opened = guest.get(f"/api/flows/{flow['id']}")
    assert opened.status_code == 200
    assert opened.json()["permission"] == "view"
    assert opened.json()["is_owner"] is False
    # It shows up on the guest's homepage.
    assert [f["id"] for f in guest.get("/api/flows").json()] == [flow["id"]]

    refused = guest.put(
        f"/api/flows/{flow['id']}/versions",
        json={"graph": graph(nodes=[node(1)], edges=[]), "base_version": 1},
    )
    assert refused.status_code == 403


def test_share_edit_saves_a_version_under_the_editors_name(client, anonymous_client):
    flow = create_flow(client)
    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")
    share_with(client, flow["id"], "bob@example.test", "edit")

    r = guest.put(
        f"/api/flows/{flow['id']}/versions",
        json={"graph": graph(nodes=[node(1, name="Kafka")], edges=[]), "base_version": 1},
    )
    assert r.status_code == 201 and r.json()["author"] == "Bob"


def test_edit_neither_deletes_nor_shares(client, anonymous_client):
    flow = create_flow(client)
    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")
    share_with(client, flow["id"], "bob@example.test", "edit")

    # Apagar e gerenciar compartilhamento pedem controle total.
    assert guest.delete(f"/api/flows/{flow['id']}").status_code == 403
    assert guest.get(f"/api/shares/{flow['id']}").status_code == 403


def test_full_control_shares_and_deletes(client, anonymous_client):
    flow = create_flow(client)
    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")
    share_with(client, flow["id"], "bob@example.test", "full")

    estado = guest.get(f"/api/shares/{flow['id']}")
    assert estado.status_code == 200
    assert estado.json()["is_owner"] is False
    assert guest.delete(f"/api/flows/{flow['id']}").status_code == 204


def test_resharing_updates_the_level(client, anonymous_client):
    flow = create_flow(client)
    register(anonymous_client, "bob@example.test", "Bob")
    share_with(client, flow["id"], "bob@example.test", "view")
    share_with(client, flow["id"], "bob@example.test", "edit")
    shares = client.get(f"/api/shares/{flow['id']}").json()["shares"]
    assert len(shares) == 1 and shares[0]["permission"] == "edit"


def test_revoking_a_share_removes_access(client, anonymous_client):
    flow = create_flow(client)
    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")
    share = share_with(client, flow["id"], "bob@example.test", "edit").json()

    assert client.delete(f"/api/shares/{flow['id']}/users/{share['id']}").status_code == 204
    assert guest.get(f"/api/flows/{flow['id']}").status_code == 404


def test_sharing_with_an_unknown_email_says_so(client):
    flow = create_flow(client)
    r = share_with(client, flow["id"], "ninguem@example.test", "view")
    assert r.status_code == 404


# ── Sharing by link ──────────────────────────────────────────────────


def test_a_link_grants_access_without_an_account(client, anonymous_client):
    flow = create_flow(client)
    link = client.post(f"/api/shares/{flow['id']}/links", json={"permission": "view"}).json()
    assert link["token"]

    anonimo = anonymous_client
    opened = anonimo.get(f"/api/shares/open/{link['token']}")
    assert opened.status_code == 200 and opened.json()["permission"] == "view"

    lido = anonimo.get(f"/api/flows/{flow['id']}", headers={"X-Share-Token": link["token"]})
    assert lido.status_code == 200
    # Sem o token, nada.
    assert anonimo.get(f"/api/flows/{flow['id']}").status_code == 401


def test_an_edit_link_allows_saving(client, anonymous_client):
    flow = create_flow(client)
    link = client.post(f"/api/shares/{flow['id']}/links", json={"permission": "edit"}).json()
    r = anonymous_client.put(
        f"/api/flows/{flow['id']}/versions",
        json={"graph": graph(nodes=[node(1)], edges=[]), "base_version": 1},
        headers={"X-Share-Token": link["token"]},
    )
    assert r.status_code == 201


def test_a_link_opened_while_signed_in_becomes_a_share(client, anonymous_client):
    flow = create_flow(client)
    link = client.post(f"/api/shares/{flow['id']}/links", json={"permission": "edit"}).json()

    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")
    guest.get(f"/api/shares/open/{link['token']}")
    # Without the token in hand the flow is still reachable -- it is on their
    # homepage now.
    assert [f["id"] for f in guest.get("/api/flows").json()] == [flow["id"]]
    assert guest.get(f"/api/flows/{flow['id']}").json()["permission"] == "edit"


def test_a_revoked_link_stops_working(client, anonymous_client):
    flow = create_flow(client)
    link = client.post(f"/api/shares/{flow['id']}/links", json={"permission": "view"}).json()
    assert client.delete(f"/api/shares/{flow['id']}/links/{link['id']}").status_code == 204
    assert anonymous_client.get(f"/api/shares/open/{link['token']}").status_code == 404


def test_an_invalid_token_opens_nothing(anonymous_client):
    assert anonymous_client.get("/api/shares/open/nao-existe").status_code == 404


def test_a_link_never_demotes_someone_who_already_edits(client, anonymous_client):
    flow = create_flow(client)
    guest = anonymous_client
    register(guest, "bob@example.test", "Bob")
    share_with(client, flow["id"], "bob@example.test", "edit")

    link = client.post(f"/api/shares/{flow['id']}/links", json={"permission": "view"}).json()
    opened = guest.get(f"/api/flows/{flow['id']}", headers={"X-Share-Token": link["token"]})
    assert opened.json()["permission"] == "edit"


# ── Sending by email ─────────────────────────────────────────────────


def test_email_without_smtp_returns_the_mailto(client):
    flow = create_flow(client)
    r = client.post(
        f"/api/shares/{flow['id']}/email",
        json={"to": "bob@example.test", "permission": "edit", "base_url": "http://x/editor/"},
    )
    assert r.status_code == 200
    corpo = r.json()
    # Without SMTP the answer is not an error: the editor falls back to the
    # local mail client.
    assert corpo["sent"] is False
    assert corpo["url"].startswith("http://x/editor/#/share/")
    assert corpo["mailto"].startswith("mailto:bob%40example.test")


def test_email_base_with_a_token_placeholder_is_a_link_template(client):
    """The Data Lineage screen sends a template so the link lands on the lineage."""
    flow = create_flow(client)
    r = client.post(
        f"/api/shares/{flow['id']}/email",
        json={"to": "bob@example.test", "permission": "view",
              "base_url": "http://x/flow-editor/#/share/{token}/lineage/mapa"},
    )
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith("http://x/flow-editor/#/share/")
    assert url.endswith("/lineage/mapa")
    assert "{token}" not in url and url.count("#/share/") == 1


def test_email_creates_a_usable_link(client, anonymous_client):
    flow = create_flow(client)
    r = client.post(
        f"/api/shares/{flow['id']}/email", json={"to": "bob@example.test", "permission": "view"}
    )
    token = r.json()["url"].rsplit("/", 1)[-1]
    assert anonymous_client.get(f"/api/shares/open/{token}").status_code == 200


# ── Searching for users ──────────────────────────────────────────────


def test_user_search_needs_three_letters(client, anonymous_client):
    register(anonymous_client, "bob@example.test", "Bob Silva")
    assert client.get("/api/users?q=bo").json() == []
    achados = client.get("/api/users?q=bob").json()
    assert [u["email"] for u in achados] == ["bob@example.test"]
    # Nunca retorna quem perguntou.
    assert client.get("/api/users?q=owner").json() == []


def test_the_tool_catalog_needs_an_account_to_write(anonymous_client):
    assert anonymous_client.get("/api/tools").status_code == 200
    assert anonymous_client.post("/api/tools", json={"name": "Trino"}).status_code == 401


# ── Changing the password ────────────────────────────────────────────


def test_changing_the_password_requires_the_current_one(client):
    r = client.post(
        "/api/auth/password", json={"current_password": "errada", "new_password": "outra-senha-123"}
    )
    assert r.status_code == 403


def test_changing_the_password_refuses_short_and_identical(client):
    curta = client.post(
        "/api/auth/password", json={"current_password": PASSWORD, "new_password": "1234"}
    )
    assert curta.status_code == 422
    igual = client.post(
        "/api/auth/password", json={"current_password": PASSWORD, "new_password": PASSWORD}
    )
    assert igual.status_code == 422


def test_the_new_password_works_on_the_next_login(client):
    nova = "new-password-of-alice-9"
    r = client.post(
        "/api/auth/password", json={"current_password": PASSWORD, "new_password": nova}
    )
    assert r.status_code == 200
    # The tab that changed the password stays signed in (session renewed).
    assert client.get("/api/auth/me").json()["user"]["email"] == "owner@example.test"

    client.post("/api/auth/logout")
    antiga = client.post("/api/auth/login", json={"email": "owner@example.test", "password": PASSWORD})
    assert antiga.status_code == 401
    ok = client.post("/api/auth/login", json={"email": "owner@example.test", "password": nova})
    assert ok.status_code == 200


def test_changing_the_password_drops_the_other_sessions(client, anonymous_client):
    # Segunda aba, mesma conta.
    outra = anonymous_client
    entrou = outra.post("/api/auth/login", json={"email": "owner@example.test", "password": PASSWORD})
    assert entrou.status_code == 200
    assert outra.get("/api/auth/me").json()["user"] is not None

    client.post(
        "/api/auth/password", json={"current_password": PASSWORD, "new_password": "senha-nova-123456"}
    )
    # Changing a password exists to throw out whoever should not be inside.
    assert outra.get("/api/auth/me").json()["user"] is None


def test_changing_the_password_needs_a_session(anonymous_client):
    r = anonymous_client.post(
        "/api/auth/password", json={"current_password": "x", "new_password": "senha-nova-123"}
    )
    assert r.status_code == 401
