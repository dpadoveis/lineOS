"""Tests for the flows API."""
import io

import pytest

from conftest import graph, group, node


def create(client, name="Flow", g=None):
    r = client.post("/api/flows", json={"name": name, "graph": g or graph()})
    assert r.status_code == 201, r.text
    return r.json()


# ── round trip and validation ────────────────────────────────────────


def test_create_returns_version_1_and_an_untouched_graph(client):
    g = graph()
    f = create(client, "Orders pipeline", g)
    assert f["current_version"] == 1
    assert f["slug"] == "orders-pipeline"
    assert f["node_count"] == 2 and f["edge_count"] == 1
    # The graph comes back value for value, y sign included (inverted on the
    # client).
    assert f["graph"] == g
    assert f["graph"]["nodes"][1]["y"] == 192


def test_reopen_by_slug_and_by_id(client):
    f = create(client, "Found by slug")
    assert client.get(f"/api/flows/{f['id']}").json()["graph"] == f["graph"]
    assert client.get(f"/api/flows/{f['slug']}").json()["id"] == f["id"]


def test_metadata_and_description_survive(client):
    f = create(client)
    n = f["graph"]["nodes"][1]
    assert n["description"] == "staging models"
    assert n["metadata"] == {"model": "staging.table_a"}


def test_node_nickname_and_size_survive(client):
    """Renaming does not erase the stack name, and a manual size returns intact."""
    f = create(client)
    n = f["graph"]["nodes"][1]
    assert n["name"] == "dbt" and n["label"] == "Silver layer"
    assert (n["width"], n["height"]) == (320, 240)
    default = f["graph"]["nodes"][0]
    assert default["label"] is None and default["width"] is None and default["height"] is None


def test_node_size_outside_the_limits_is_refused(client):
    for field, value in (("width", 40), ("width", 5000), ("height", 90), ("height", 5000)):
        g = graph(nodes=[node(1, **{field: value})], edges=[])
        r = client.post("/api/flows", json={"name": "x", "graph": g})
        assert r.status_code == 422, (field, value, r.text)


def test_groups_and_their_membership_survive(client):
    """A group box returns value for value, and so does the node inside it."""
    g = graph(
        nodes=[node(1, group=7), node(2)],
        edges=[],
        groups=[group(7, name="Ingestion", x=-480, y=120, width=520, height=320, color="#7dd3a0")],
    )
    f = create(client, "With a group", g)
    assert f["graph"] == g
    assert f["graph"]["groups"][0]["name"] == "Ingestion"
    assert f["graph"]["nodes"][0]["group"] == 7 and f["graph"]["nodes"][1]["group"] is None


def test_a_flow_saved_before_groups_still_opens(client):
    """`groups` is optional: the documents saved before the feature stay valid."""
    old = graph(nodes=[node(1)], edges=[])
    del old["groups"]
    del old["nodes"][0]["group"]
    f = create(client, "Older flow", old)
    assert f["graph"]["groups"] == []
    assert f["graph"]["nodes"][0]["group"] is None


def test_slug_collides_without_error(client):
    a = create(client, "Same name")
    b = create(client, "Same name")
    assert a["slug"] == "same-name" and b["slug"] == "same-name-2"


def test_accented_name_becomes_an_ascii_slug(client):
    assert create(client, "Ingestão & Transformação")["slug"] == "ingestao-transformacao"


@pytest.mark.parametrize(
    "g, reason",
    [
        ({**graph(), "kind": "flow-node"}, "wrong kind"),
        ({**graph(), "version": 2}, "wrong version"),
        (graph(nodes=[node(1)], edges=[{"id": 1, "from": 1, "to": 9, "label": None}]), "no such node"),
        (graph(nodes=[node(1)], edges=[{"id": 1, "from": 1, "to": 1, "label": None}]), "self loop"),
        (
            graph(
                nodes=[node(1), node(2)],
                edges=[
                    {"id": 1, "from": 1, "to": 2, "label": None},
                    {"id": 2, "from": 1, "to": 2, "label": None},
                ],
            ),
            "duplicate edge",
        ),
        (graph(nodes=[node(1), node(1)], edges=[]), "repeated node id"),
        (graph(nodes=[node(1, color="red")], edges=[]), "invalid colour"),
        (graph(nodes=[node(1, extra=1)], edges=[]), "unknown field"),
        (graph(nodes=[node(i) for i in range(1, 502)], edges=[]), "above the node limit"),
        (graph(nodes=[node(1, group=9)], edges=[]), "node in a group that does not exist"),
        (graph(nodes=[], edges=[], groups=[group(1), group(1)]), "repeated group id"),
        (graph(nodes=[], edges=[], groups=[group(1, width=40)]), "group narrower than the minimum"),
        (graph(nodes=[], edges=[], groups=[group(1, height=9000)]), "group taller than the maximum"),
        (graph(nodes=[], edges=[], groups=[group(1, color="red")]), "invalid group colour"),
        (graph(nodes=[], edges=[], groups=[group(i) for i in range(1, 202)]), "above the group limit"),
    ],
)
def test_invalid_graph_is_refused(client, g, reason):
    r = client.post("/api/flows", json={"name": "x", "graph": g})
    assert r.status_code == 422, f"{reason} should have been refused: {r.text}"


# ── versioning ───────────────────────────────────────────────────────


def test_save_version_increments_and_keeps_the_history(client):
    f = create(client)
    g2 = graph(nodes=[node(1, name="Airflow v2")], edges=[])
    r = client.put(
        f"/api/flows/{f['id']}/versions", json={"graph": g2, "base_version": 1, "note": "drop dbt"}
    )
    assert r.status_code == 201 and r.json()["version"] == 2
    # With accounts, the version's author is the name of whoever saved
    # (settings.AUTHOR only applies to a save arriving through a share link).
    assert r.json()["author"] == "Owner"

    history = client.get(f"/api/flows/{f['id']}/versions").json()
    assert [v["version"] for v in history] == [2, 1]
    # v1 was left alone.
    assert client.get(f"/api/flows/{f['id']}/versions/1").json()["graph"] == f["graph"]


def test_stale_base_version_answers_409(client):
    f = create(client)
    body = {"graph": graph(), "base_version": 1}
    assert client.put(f"/api/flows/{f['id']}/versions", json=body).status_code == 201
    r = client.put(f"/api/flows/{f['id']}/versions", json=body)
    assert r.status_code == 409
    assert r.json()["detail"]["current_version"] == 2


def test_restoring_a_version_creates_a_new_one_and_erases_nothing(client):
    f = create(client)
    client.put(
        f"/api/flows/{f['id']}/versions",
        json={"graph": graph(nodes=[node(1)], edges=[]), "base_version": 1},
    )
    r = client.post(f"/api/flows/{f['id']}/versions/1/restore")
    assert r.status_code == 201
    assert r.json()["version"] == 3
    assert r.json()["graph"] == f["graph"]
    assert [v["version"] for v in client.get(f"/api/flows/{f['id']}/versions").json()] == [3, 2, 1]


def test_missing_version_404(client):
    f = create(client)
    assert client.get(f"/api/flows/{f['id']}/versions/99").status_code == 404


# ── draft ────────────────────────────────────────────────────────────


def test_draft_creates_no_version_and_returns_on_reopen(client):
    f = create(client)
    g = graph(nodes=[node(1, description="being edited")], edges=[])
    r = client.put(f"/api/flows/{f['id']}/draft", json={"graph": g})
    assert r.status_code == 200
    assert r.json()["current_version"] == 1 and r.json()["has_draft"] is True

    opened = client.get(f"/api/flows/{f['id']}").json()
    assert opened["graph_source"] == "draft"
    assert opened["graph"]["nodes"][0]["description"] == "being edited"
    assert len(client.get(f"/api/flows/{f['id']}/versions").json()) == 1


def test_saving_a_version_consumes_the_draft(client):
    f = create(client)
    client.put(f"/api/flows/{f['id']}/draft", json={"graph": graph()})
    client.put(f"/api/flows/{f['id']}/versions", json={"graph": graph(), "base_version": 1})
    opened = client.get(f"/api/flows/{f['id']}").json()
    assert opened["has_draft"] is False and opened["graph_source"] == "version"


# ── metadata, listing and trash ──────────────────────────────────────


def test_patch_renames_without_creating_a_version(client):
    f = create(client, "Old name")
    r = client.patch(f"/api/flows/{f['id']}", json={"name": "New name", "description": "d"})
    assert r.status_code == 200
    assert r.json()["name"] == "New name" and r.json()["slug"] == "new-name"
    assert r.json()["current_version"] == 1


def test_search_by_name(client):
    create(client, "Daily orders")
    create(client, "Inventory")
    assert [f["name"] for f in client.get("/api/flows?q=orders").json()] == ["Daily orders"]


def test_trash_hides_restores_and_purges(client):
    f = create(client)
    assert client.delete(f"/api/flows/{f['id']}").status_code == 204
    assert client.get(f"/api/flows/{f['id']}").status_code == 410
    assert client.get("/api/flows").json() == []
    assert len(client.get("/api/flows?trashed=true").json()) == 1

    assert client.post(f"/api/flows/{f['id']}/restore").status_code == 200
    assert client.get(f"/api/flows/{f['id']}").status_code == 200

    assert client.delete(f"/api/flows/{f['id']}?purge=true").status_code == 204
    assert client.get(f"/api/flows/{f['id']}").status_code == 404


def test_export_carries_content_disposition(client):
    f = create(client, "To export")
    r = client.get(f"/api/flows/{f['id']}/export")
    assert r.status_code == 200
    assert "to-export.json" in r.headers["content-disposition"]
    assert r.json() == f["graph"]


def test_missing_flow_404(client):
    assert client.get("/api/flows/9999").status_code == 404


# ── attachments ──────────────────────────────────────────────────────

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 200


def test_png_upload_download_and_delete(client):
    f = create(client)
    r = client.post(
        f"/api/flows/{f['id']}/files",
        files={"file": ("flow.png", io.BytesIO(PNG), "image/png")},
        data={"kind": "png"},
    )
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["size_bytes"] == len(PNG) and a["flow_version"] == 1

    assert client.get(f"/api/flows/{f['id']}/files").json()[0]["id"] == a["id"]
    assert client.get(f"/api/files/{a['id']}").content == PNG
    assert client.delete(f"/api/files/{a['id']}").status_code == 204
    assert client.get(f"/api/files/{a['id']}").status_code == 404


def test_file_type_is_refused(client):
    f = create(client)
    r = client.post(
        f"/api/flows/{f['id']}/files",
        files={"file": ("x.exe", io.BytesIO(b"MZ"), "application/x-msdownload")},
    )
    assert r.status_code == 415


def test_identical_content_is_deduplicated(client):
    f = create(client)
    upload = lambda: client.post(  # noqa: E731
        f"/api/flows/{f['id']}/files",
        files={"file": ("flow.png", io.BytesIO(PNG), "image/png")},
        data={"kind": "png"},
    ).json()
    a, b = upload(), upload()
    assert a["id"] != b["id"]
    # The same blob on disk: storage addresses by sha256.
    assert client.get(f"/api/files/{a['id']}").content == client.get(
        f"/api/files/{b['id']}"
    ).content


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok", "database": "ok"}


def test_node_uid_survives_the_round_trip(client):
    """A binding anchors on uid, so the API must return it untouched."""
    g = graph(nodes=[node(1, uid="a1b2c3d4-0000-4000-8000-000000000001")], edges=[])
    f = create(client, "With uid", g)
    assert f["graph"]["nodes"][0]["uid"] == "a1b2c3d4-0000-4000-8000-000000000001"


def test_node_without_uid_is_still_accepted(client):
    """Diagrams saved before the field existed must keep opening."""
    g = graph(nodes=[node(1)], edges=[])
    f = create(client, "No uid", g)
    assert f["graph"]["nodes"][0]["uid"] is None
