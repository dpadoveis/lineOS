"""Tests for the custom tool catalog (/api/tools).

English, like the feature itself — see AGENT.md. The flow tests next door stay
in Portuguese.
"""
import base64

from conftest import graph, node

# Smallest valid PNG: 1x1 transparent pixel.
PIXEL = (
    "data:image/png;base64,"
    + base64.b64encode(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
            "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae"
            "426082"
        )
    ).decode()
)


def create(client, **fields):
    body = {"name": "Trino"}
    body.update(fields)
    r = client.post("/api/tools", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_fills_slug_initials_and_defaults(client):
    tool = create(client, name="Delta Lake")
    assert tool["slug"] == "delta-lake"
    # Initials default to one letter per word.
    assert tool["initials"] == "DL"
    assert tool["category"] == "CUSTOM"
    assert tool["color"] == "#9aa4b0"
    assert tool["icon"] is None


def test_single_word_name_takes_two_letters(client):
    assert create(client, name="Trino")["initials"] == "TR"


def test_explicit_fields_win(client):
    tool = create(
        client,
        name="Internal API",
        category="ingestion",
        initials="api",
        color="#6fb8d3",
        tags="rest http interno",
    )
    assert tool["initials"] == "API"
    assert tool["category"] == "INGESTION"
    assert tool["tags"] == "rest http interno"


def test_colliding_names_get_distinct_slugs(client):
    a = create(client, name="Same Name")
    b = create(client, name="Same Name")
    assert a["slug"] == "same-name" and b["slug"] == "same-name-2"


def test_icon_round_trips(client):
    tool = create(client, name="With Icon", icon=PIXEL)
    assert tool["icon"] == PIXEL
    assert client.get("/api/tools").json()[0]["icon"] == PIXEL


def test_icon_must_be_a_raster_data_url(client):
    r = client.post(
        "/api/tools",
        json={"name": "Svg", "icon": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="},
    )
    assert r.status_code == 422


def test_icon_above_the_ceiling_is_refused(client):
    from app.config import settings

    huge = "data:image/png;base64," + "A" * (settings.max_tool_icon_bytes + 1)
    assert client.post("/api/tools", json={"name": "Huge", "icon": huge}).status_code == 422


def test_list_is_newest_first_and_filters(client):
    create(client, name="First", tags="alpha")
    create(client, name="Second", tags="beta")
    names = [t["name"] for t in client.get("/api/tools").json()]
    assert names == ["Second", "First"]
    assert [t["name"] for t in client.get("/api/tools?q=alpha").json()] == ["First"]


def test_patch_renames_and_clears_the_icon(client):
    tool = create(client, name="Old Name", icon=PIXEL)
    r = client.patch(f"/api/tools/{tool['id']}", json={"name": "New Name", "icon": ""})
    assert r.status_code == 200
    assert r.json()["slug"] == "new-name"
    assert r.json()["icon"] is None


def test_patch_without_icon_keeps_it(client):
    tool = create(client, name="Keeps Icon", icon=PIXEL)
    r = client.patch(f"/api/tools/{tool['id']}", json={"category": "STREAM"})
    assert r.json()["icon"] == PIXEL


def test_delete_removes_from_the_catalog(client):
    tool = create(client, name="Temporary")
    assert client.delete(f"/api/tools/{tool['id']}").status_code == 204
    assert client.get("/api/tools").json() == []
    assert client.delete(f"/api/tools/{tool['id']}").status_code == 404


def test_a_tool_used_in_a_diagram_cannot_be_deleted(client):
    tool = create(client, name="Doomed")
    g = graph(nodes=[node(1, name="Doomed", tool=tool["slug"])], edges=[])
    client.post("/api/flows", json={"name": "Uses tool", "graph": g})
    r = client.delete(f"/api/tools/{tool['id']}")
    assert r.status_code == 409
    assert "Uses tool" in r.json()["detail"]
    # And it is still in the catalog.
    assert [t["name"] for t in client.get("/api/tools").json()] == ["Doomed"]


def test_a_diagram_in_the_trash_still_counts(client):
    """Restoring it would bring the nodes back."""
    tool = create(client, name="Doomed")
    g = graph(nodes=[node(1, name="Doomed", tool=tool["slug"])], edges=[])
    flow = client.post("/api/flows", json={"name": "Trashed", "graph": g}).json()
    client.delete(f"/api/flows/{flow['id']}")
    assert client.delete(f"/api/tools/{tool['id']}").status_code == 409


def test_deleting_a_tool_leaves_stored_graphs_alone(client):
    """Once no diagram holds it, the delete goes through -- and the graphs that
    ONCE held it keep every visual field, losing only the icon lookup."""
    tool = create(client, name="Doomed", icon=PIXEL)
    g = graph(nodes=[node(1, name="Doomed", tool=tool["slug"])], edges=[])
    flow = client.post("/api/flows", json={"name": "Used to use it", "graph": g}).json()
    # The node leaves the diagram: a new version without it.
    empty = graph(nodes=[], edges=[])
    r = client.put(
        f"/api/flows/{flow['id']}/versions",
        json={"graph": empty, "base_version": flow["current_version"]},
    )
    assert r.status_code == 201, r.text
    assert client.delete(f"/api/tools/{tool['id']}").status_code == 204
    # Version 1 still holds the node, exactly as it was written.
    v1 = client.get(f"/api/flows/{flow['id']}/versions/1").json()
    assert v1["graph"]["nodes"][0]["tool"] == tool["slug"]
    assert v1["graph"]["nodes"][0]["name"] == "Doomed"


def test_usage_answers_for_a_registered_tool_and_for_a_builtin(client):
    tool = create(client, name="Registered")
    g = graph(
        nodes=[
            node(1, name="Registered", tool=tool["slug"]),
            # A node made from a built-in: no slug, the name is the reference.
            node(2, name="Airflow"),
        ],
        edges=[],
    )
    client.post("/api/flows", json={"name": "Both", "graph": g})

    by_slug = client.get(f"/api/tools/usage?slug={tool['slug']}&name=Registered").json()
    assert by_slug["count"] == 1
    assert by_slug["flows"][0]["name"] == "Both"
    assert by_slug["flows"][0]["deleted"] is False

    by_name = client.get("/api/tools/usage?name=Airflow").json()
    assert by_name["count"] == 1

    assert client.get("/api/tools/usage?name=Nobody+Uses+This").json() == {
        "count": 0,
        "flows": [],
    }


def test_a_name_only_matches_nodes_without_a_tool(client):
    """A node carrying a slug belongs to THAT tool, whatever it is called."""
    other = create(client, name="Airflow")
    g = graph(nodes=[node(1, name="Airflow", tool=other["slug"])], edges=[])
    client.post("/api/flows", json={"name": "Registered Airflow", "graph": g})
    # The built-in of the same name is not the one in use.
    assert client.get("/api/tools/usage?name=Airflow").json()["count"] == 0
    assert client.get(f"/api/tools/usage?slug={other['slug']}").json()["count"] == 1


def test_editing_a_builtin_materialises_it_once(client):
    tool = create(client, name="Airflow 2", builtin="Airflow", category="ORCHESTRATION")
    assert tool["builtin"] == "Airflow"
    assert tool["hidden"] is False
    # A second row for the same built-in would make the catalog ambiguous.
    r = client.post("/api/tools", json={"name": "Again", "builtin": "Airflow"})
    assert r.status_code == 409


def test_a_builtin_is_hidden_rather_than_removed(client):
    """Deleting its row would only put the source entry back in the sidebar."""
    tool = create(client, name="Airflow", builtin="Airflow")
    assert client.delete(f"/api/tools/{tool['id']}").status_code == 204
    listed = client.get("/api/tools").json()
    assert len(listed) == 1
    assert listed[0]["hidden"] is True
    assert listed[0]["builtin"] == "Airflow"


def test_a_builtin_can_be_hidden_in_one_call(client):
    tool = create(client, name="Spark", builtin="Spark", hidden=True)
    assert tool["hidden"] is True


def test_hidden_only_makes_sense_for_a_builtin(client):
    r = client.post("/api/tools", json={"name": "Nope", "hidden": True})
    assert r.status_code == 422


def test_a_builtin_in_use_cannot_be_hidden(client):
    g = graph(nodes=[node(1, name="Kafka")], edges=[])
    client.post("/api/flows", json={"name": "Streaming", "graph": g})
    r = client.post("/api/tools", json={"name": "Kafka", "builtin": "Kafka", "hidden": True})
    assert r.status_code == 409
    assert "Streaming" in r.json()["detail"]


def test_node_tool_defaults_to_null_and_round_trips(client):
    g = graph(nodes=[node(1), node(2, tool="my-tool")], edges=[])
    flow = client.post("/api/flows", json={"name": "Mixed", "graph": g}).json()
    nodes = flow["graph"]["nodes"]
    assert nodes[0]["tool"] is None and nodes[1]["tool"] == "my-tool"
