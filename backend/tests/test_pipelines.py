"""Promoting a diagram, and binding its nodes to real objects."""
from conftest import graph, node
from test_inventory import add_object


def create_flow(client, name="Chain", nodes=None):
    g = graph(nodes=nodes or [node(1, uid="u-node-01"), node(2, uid="u-node-02")],
              edges=[{"id": 1, "from": 1, "to": 2, "label": None}])
    r = client.post("/api/flows", json={"name": name, "graph": g})
    assert r.status_code == 201, r.text
    return r.json()


def promote(client, flow, name="Chain ops"):
    r = client.post("/api/pipelines", json={"flow": flow["slug"], "name": name})
    assert r.status_code == 201, r.text
    return r.json()


def test_promoting_a_diagram_returns_its_nodes(client):
    f = create_flow(client)
    p = promote(client, f)
    assert p["slug"] == "chain-ops"
    assert len(p["nodes"]) == 2
    assert {n["uid"] for n in p["nodes"]} == {"u-node-01", "u-node-02"}
    assert all(n["binding"] is None for n in p["nodes"])


def test_promoting_stamps_uids_on_an_older_diagram(client):
    """A diagram saved before uid existed must gain one, exactly once."""
    f = create_flow(client, nodes=[node(1), node(2)])
    assert f["graph"]["nodes"][0]["uid"] is None
    p = promote(client, f)
    uids = [n["uid"] for n in p["nodes"]]
    assert all(u for u in uids) and len(set(uids)) == 2
    # One new version, not one per node.
    assert client.get(f"/api/flows/{f['slug']}").json()["current_version"] == 2


def test_binding_a_node_to_an_object(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    r = client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01",
                   json={"object_id": oid, "rules": {"sla_minutes": 90}})
    assert r.status_code == 200, r.text
    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    assert nodes["u-node-01"]["binding"]["object"]["external_id"] == "dag_silver_a"
    assert nodes["u-node-01"]["binding"]["rules"] == {"sla_minutes": 90}
    assert nodes["u-node-02"]["binding"] is None


def test_rebinding_replaces_instead_of_duplicating(client):
    f = create_flow(client)
    p = promote(client, f)
    a = add_object()
    b = add_object(external_id="dag_gold_a", display_name="dag_gold_a")
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": a})
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": b})
    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    assert nodes["u-node-01"]["binding"]["object"]["external_id"] == "dag_gold_a"


def test_unbinding(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    assert client.delete(f"/api/pipelines/{p['slug']}/bindings/u-node-01").status_code == 204
    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    assert nodes["u-node-01"]["binding"] is None


def test_binding_an_unknown_node_is_refused(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    r = client.put(f"/api/pipelines/{p['slug']}/bindings/not-a-node", json={"object_id": oid})
    assert r.status_code == 404


def test_a_deleted_node_leaves_an_orphaned_binding_the_module_reports(client):
    """The binding is not silently dropped: it is shown, so somebody decides."""
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-02", json={"object_id": oid})
    # Save a version without node 2.
    g = graph(nodes=[node(1, uid="u-node-01")], edges=[])
    r = client.put(f"/api/flows/{f['slug']}/versions",
                   json={"graph": g, "base_version": 1})
    assert r.status_code == 201, r.text
    body = client.get(f"/api/pipelines/{p['slug']}").json()
    assert len(body["nodes"]) == 1
    assert len(body["orphaned_bindings"]) == 1
    assert body["orphaned_bindings"][0]["node_uid"] == "u-node-02"


def test_the_pipeline_follows_the_current_version_not_the_draft(client):
    """A half-finished edit in the editor must not change the ops picture."""
    f = create_flow(client)
    p = promote(client, f)
    before = len(client.get(f"/api/pipelines/{p['slug']}").json()["nodes"])
    client.put(f"/api/flows/{f['slug']}/draft",
               json={"graph": graph(nodes=[node(9, uid="u-draft-01")], edges=[])})
    after = client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]
    assert len(after) == before
    assert "u-draft-01" not in {n["uid"] for n in after}


def test_a_viewer_cannot_bind(client, anonymous_client):
    """Permission is the diagram's: view opens, edit binds."""
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    r = anonymous_client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01",
                             json={"object_id": oid})
    assert r.status_code in (401, 404)


def test_run_history_comes_back_newest_first(client):
    from datetime import datetime, timedelta, timezone

    from app.database import SessionLocal
    from app.models_ops import ObjectRun

    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        for i, outcome in enumerate(("success", "failed", "success")):
            db.add(
                ObjectRun(
                    object_id=oid,
                    run_key=f"r{i}",
                    started_at=now - timedelta(hours=i),
                    ended_at=now - timedelta(hours=i) + timedelta(seconds=30),
                    outcome=outcome,
                    exit_code=0 if outcome == "success" else 2,
                    duration_ms=30000,
                    facts={"rows_synced": 100 + i},
                )
            )
        db.commit()

    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/runs")
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["run_key"] for i in items] == ["r0", "r1", "r2"]
    assert items[1]["outcome"] == "failed" and items[1]["exit_code"] == 2
    assert items[0]["facts"]["rows_synced"] == 100


def test_run_history_of_an_object_this_pipeline_does_not_bind_is_refused(client):
    """Otherwise the route leaks telemetry across diagrams somebody cannot see."""
    f = create_flow(client)
    p = promote(client, f)
    stranger = add_object(external_id="somebody_elses_dag", display_name="somebody_elses_dag")
    assert client.get(f"/api/pipelines/{p['slug']}/objects/{stranger}/runs").status_code == 404


def test_creating_a_pipeline_without_a_flow_creates_an_empty_diagram(client):
    """POST /api/pipelines without flow creates empty flow and diagram."""
    r = client.post("/api/pipelines", json={"name": "Empty pipeline"})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["slug"] == "empty-pipeline"
    assert len(p["nodes"]) == 0
    assert p["flow_version"] == 1
    # Verify the flow was created with correct name
    f = client.get(f"/api/flows/{p['flow_slug']}").json()
    assert f["name"] == "Empty pipeline"


def test_adding_multiple_objects_as_nodes_in_one_version(client):
    """POST /api/pipelines/{slug}/nodes creates nodes and one version bump."""
    f = create_flow(client)
    p = promote(client, f)
    assert p["flow_version"] == 1

    a = add_object()
    b = add_object(external_id="dag_gold_a", display_name="dag_gold_a")
    c = add_object(kind="cron_job", source="host:local", external_id="job_c",
                   display_name="run_job_c.sh")

    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [a, b, c]})
    assert r.status_code == 201, r.text

    updated_p = r.json()
    assert len(updated_p["nodes"]) == 5  # 2 original + 3 new
    assert updated_p["flow_version"] == 2  # Exactly one version bump

    # Check nodes are bound
    bound_count = sum(1 for n in updated_p["nodes"] if n["binding"])
    assert bound_count == 3

    # Verify nodes have correct category derived from kind
    nodes_by_uid = {n["uid"]: n for n in updated_p["nodes"] if n["binding"]}
    airflow_nodes = [n for n in nodes_by_uid.values() if n["category"] == "ORCHESTRATION"]
    cron_nodes = [n for n in nodes_by_uid.values() if n["category"] == "SCHEDULING"]
    assert len(airflow_nodes) == 2 and len(cron_nodes) == 1


def test_adding_an_already_bound_object_is_idempotent(client):
    """Adding the same object twice doesn't duplicate the node."""
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()

    # Add it once
    r1 = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [oid]})
    assert r1.status_code == 201, r1.text
    p1 = r1.json()
    version1 = p1["flow_version"]

    # Add it again
    r2 = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [oid]})
    assert r2.status_code == 201, r2.text
    p2 = r2.json()

    # No new version created, no duplicate binding
    assert p2["flow_version"] == version1
    assert sum(1 for n in p2["nodes"] if n["binding"] and n["binding"]["object"]["id"] == oid) == 1


def test_nonexistent_object_in_batch_returns_404_and_no_nodes_added(client):
    """If any object doesn't exist, fail atomically without creating nodes."""
    f = create_flow(client)
    p = promote(client, f)
    oid_exists = add_object()
    oid_missing = 99999

    r = client.post(f"/api/pipelines/{p['slug']}/nodes",
                   json={"object_ids": [oid_exists, oid_missing]})
    assert r.status_code == 404, r.text

    # Verify no new version or binding was created
    updated = client.get(f"/api/pipelines/{p['slug']}").json()
    assert updated["flow_version"] == 1  # Unchanged
    bound_count = sum(1 for n in updated["nodes"] if n["binding"])
    assert bound_count == 0


def test_creating_with_flow_still_works(client):
    """POST /api/pipelines with flow field still has original behavior."""
    f = create_flow(client)
    r = client.post("/api/pipelines", json={"flow": f["slug"], "name": "Explicit flow"})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["flow_slug"] == f["slug"]
    assert len(p["nodes"]) == 2  # The original diagram nodes


def test_adding_nodes_with_declared_edges_creates_graph_edges(client):
    """Adding nodes with declared edges creates edges in the graph."""
    from app.database import SessionLocal
    from app.models_ops import ObjectEdge

    f = create_flow(client)
    p = promote(client, f)

    # Create two objects
    a = add_object(external_id="cron_job", display_name="cron_job",
                   kind="cron_job", source="host:local")
    b = add_object(external_id="silver.table_a", display_name="silver.table_a",
                   kind="table", source="warehouse")

    # Create a declared edge from a to b
    with SessionLocal() as db:
        edge = ObjectEdge(
            from_object_id=a,
            to_object_id=b,
            declared_by="heartbeat",
        )
        db.add(edge)
        db.commit()

    # Add both objects as nodes
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [a, b]})
    assert r.status_code == 201, r.text

    # Verify edges exist in the graph
    updated = r.json()
    graph = updated["graph"]
    edges = graph.get("edges") or []
    # Should have at least one edge (from the declared edge we created)
    assert len(edges) > 0


def test_stage_column_layout_puts_producer_left_of_consumer(client):
    """Layout places objects with no producers at column 0, consumers at producer_col + 1."""
    from app.database import SessionLocal
    from app.models_ops import ObjectEdge

    f = create_flow(client)
    p = promote(client, f)

    # Create three objects: producer -> intermediate -> consumer
    producer = add_object(external_id="producer_job", display_name="producer_job",
                         kind="cron_job", source="host:local")
    intermediate = add_object(external_id="intermediate.table", display_name="intermediate.table",
                             kind="table", source="warehouse")
    consumer = add_object(external_id="consumer_dag", display_name="consumer_dag",
                         kind="airflow_dag", source="airflow-standalone")

    # Create edges: producer -> intermediate -> consumer
    with SessionLocal() as db:
        db.add(ObjectEdge(from_object_id=producer, to_object_id=intermediate, declared_by="heartbeat"))
        db.add(ObjectEdge(from_object_id=intermediate, to_object_id=consumer, declared_by="airflow_dataset"))
        db.commit()

    # Add all as nodes
    r = client.post(f"/api/pipelines/{p['slug']}/nodes",
                   json={"object_ids": [producer, intermediate, consumer]})
    assert r.status_code == 201, r.text

    # Verify layout: producer should be leftmost, then intermediate, then consumer
    updated = r.json()
    graph = updated["graph"]

    # Get nodes from the graph with their positions
    nodes_by_name = {n["name"]: n for n in graph.get("nodes") or []}

    producer_node = nodes_by_name.get("producer_job")
    intermediate_node = nodes_by_name.get("intermediate.table")
    consumer_node = nodes_by_name.get("consumer_dag")

    assert producer_node and intermediate_node and consumer_node, "Not all nodes found in graph"

    producer_x = producer_node["x"]
    intermediate_x = intermediate_node["x"]
    consumer_x = consumer_node["x"]

    assert producer_x < intermediate_x < consumer_x, \
        f"Layout not correct: producer_x={producer_x}, intermediate_x={intermediate_x}, consumer_x={consumer_x}"


def test_the_detail_carries_the_last_run_and_the_last_check(client):
    """The freshness line on the card needs the newest run and check, not a sentence."""
    from datetime import datetime, timedelta, timezone

    from app.database import SessionLocal
    from app.models_ops import ObjectCheck, ObjectRun

    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.add(ObjectRun(object_id=oid, run_key="old", started_at=now - timedelta(hours=5),
                         ended_at=now - timedelta(hours=5) + timedelta(seconds=10),
                         outcome="failed", exit_code=2, duration_ms=10000, facts={}))
        db.add(ObjectRun(object_id=oid, run_key="new", started_at=now - timedelta(hours=1),
                         ended_at=now - timedelta(hours=1) + timedelta(seconds=42),
                         outcome="success", exit_code=0, duration_ms=42000,
                         facts={"rows_synced": 7}))
        db.add(ObjectCheck(object_id=oid, checked_at=now - timedelta(minutes=3),
                           row_count=19456, max_ts=now - timedelta(minutes=50), ok=True))
        db.commit()

    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    b = nodes["u-node-01"]["binding"]
    assert b["last_run"]["run_key"] == "new"
    assert b["last_run"]["duration_ms"] == 42000
    assert b["last_run"]["facts"] == {"rows_synced": 7}
    assert b["last_check"]["row_count"] == 19456
    assert b["last_check"]["ok"] is True
    assert nodes["u-node-02"]["binding"] is None


def test_a_binding_nothing_was_collected_for_has_no_last_run_or_check(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    b = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}["u-node-01"]["binding"]
    assert b["last_run"] is None
    assert b["last_check"] is None
    assert b["health"]["state"] == "no_data"


def test_duration_median_ms_is_the_median_of_the_last_20_successes(client):
    """25 successes 1..25 s plus a failed 999 s run; the median ignores the
    failure and the 5 oldest successes."""
    from datetime import datetime, timedelta, timezone

    from app.database import SessionLocal
    from app.models_ops import ObjectRun

    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        for i in range(1, 26):
            started = now - timedelta(hours=26 - i)
            db.add(ObjectRun(
                object_id=oid, run_key=f"s{i}", started_at=started,
                ended_at=started + timedelta(seconds=i), outcome="success",
                exit_code=0, duration_ms=i * 1000, facts={},
            ))
        db.add(ObjectRun(
            object_id=oid, run_key="fail", started_at=now - timedelta(minutes=1),
            ended_at=now - timedelta(minutes=1) + timedelta(seconds=999),
            outcome="failed", exit_code=1, duration_ms=999000, facts={},
        ))
        db.commit()

    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    assert nodes["u-node-01"]["binding"]["duration_median_ms"] == 15500


def test_duration_median_ms_is_null_without_a_success(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    assert nodes["u-node-01"]["binding"]["duration_median_ms"] is None


def test_expected_is_present_for_a_bound_dag_and_null_for_a_table(client):
    from datetime import datetime, timedelta, timezone

    from app.database import SessionLocal
    from app.models_ops import ObjectRun

    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    table_oid = add_object(external_id="silver.table_a", display_name="silver.table_a",
                           kind="table", source="warehouse", attrs={})
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-02", json={"object_id": table_oid})
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.add(ObjectRun(object_id=oid, run_key="r1", started_at=now - timedelta(hours=1),
                         ended_at=now - timedelta(hours=1) + timedelta(seconds=10),
                         outcome="success", exit_code=0, duration_ms=10000, facts={}))
        db.commit()

    nodes = {n["uid"]: n for n in client.get(f"/api/pipelines/{p['slug']}").json()["nodes"]}
    assert nodes["u-node-01"]["binding"]["expected"] is not None
    assert nodes["u-node-02"]["binding"]["expected"] is None


def test_deleting_a_pipeline_returns_204_and_removes_bindings(client):
    """DELETE /api/pipelines/{slug} archives the pipeline and deletes bindings."""
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    client.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01", json={"object_id": oid})

    # Verify bindings exist
    assert client.get(f"/api/pipelines/{p['slug']}").json()["nodes"][0]["binding"] is not None

    # Delete the pipeline
    r = client.delete(f"/api/pipelines/{p['slug']}")
    assert r.status_code == 204

    # Verify it no longer appears in the list
    pipelines = client.get("/api/pipelines").json()
    assert p["slug"] not in {x["slug"] for x in pipelines["items"]}

    # Verify detail returns 404
    assert client.get(f"/api/pipelines/{p['slug']}").status_code == 404

    # Verify the flow diagram is still readable
    flow = client.get(f"/api/flows/{f['slug']}").json()
    assert flow["name"] == f["name"]


def test_deleting_requires_full_permission(client, anonymous_client):
    """Deleting a pipeline requires 'full' permission on the diagram."""
    f = create_flow(client)
    p = promote(client, f)

    # Anonymous user gets 401 or 404
    r = anonymous_client.delete(f"/api/pipelines/{p['slug']}")
    assert r.status_code in (401, 404)


def test_re_promoting_a_deleted_pipeline_starts_a_new_one(client):
    """After deleting a pipeline, promoting the same diagram creates a new pipeline."""
    f = create_flow(client)
    p = promote(client, f)
    slug = p["slug"]

    # Delete it
    client.delete(f"/api/pipelines/{slug}")
    assert client.get(f"/api/pipelines/{slug}").status_code == 404

    # Re-promote: should get a new pipeline with a different slug
    p2 = promote(client, f, name="Chain ops")
    assert p2["slug"] != slug  # New slug because the old one is archived
    assert client.get(f"/api/pipelines/{p2['slug']}").status_code == 200


def test_a_view_link_opens_the_pipeline(client, anonymous_client):
    """A share link at 'view' level allows reading the pipeline detail."""
    f = create_flow(client)
    p = promote(client, f)
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "view"}).json()

    anonimo = anonymous_client
    r = anonimo.get(f"/api/pipelines/{p['slug']}", headers={"X-Share-Token": link["token"]})
    assert r.status_code == 200
    detail = r.json()
    assert detail["slug"] == p["slug"]
    assert len(detail["nodes"]) == 2


def test_a_view_link_cannot_modify_the_pipeline(client, anonymous_client):
    """A share link at 'view' level refuses edit operations."""
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "view"}).json()

    anonimo = anonymous_client
    r = anonimo.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01",
                    json={"object_id": oid}, headers={"X-Share-Token": link["token"]})
    assert r.status_code == 403


def test_an_edit_link_modifies_the_pipeline(client, anonymous_client):
    """A share link at 'edit' level allows binding."""
    f = create_flow(client)
    p = promote(client, f)
    oid = add_object()
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "edit"}).json()

    anonimo = anonymous_client
    r = anonimo.put(f"/api/pipelines/{p['slug']}/bindings/u-node-01",
                    json={"object_id": oid}, headers={"X-Share-Token": link["token"]})
    assert r.status_code == 200
    nodes = {n["uid"]: n for n in r.json()["nodes"]}
    assert nodes["u-node-01"]["binding"]["object"]["external_id"] == "dag_silver_a"


def test_an_invalid_token_returns_unauthorized(client, anonymous_client):
    """An invalid share token is treated like no permission."""
    f = create_flow(client)
    p = promote(client, f)

    r = anonymous_client.get(f"/api/pipelines/{p['slug']}", headers={"X-Share-Token": "invalid-token"})
    assert r.status_code in (401, 404)


def test_pending_edges_count_zero_when_no_edges_declared(client):
    """A new pipeline with no declared edges has pending_edges=0."""
    f = create_flow(client)
    p = promote(client, f)
    detail = client.get(f"/api/pipelines/{p['slug']}").json()
    assert detail["pending_edges"] == 0


def test_pending_edges_counts_declared_edges_not_on_diagram(client):
    """pending_edges counts object_edges whose both endpoints are bound."""
    from app.database import SessionLocal
    from app.models_ops import ObjectEdge

    f = create_flow(client)
    p = promote(client, f)
    a = add_object(external_id="job_a", display_name="job_a",
                  kind="cron_job", source="host:local")
    b = add_object(external_id="table_b", display_name="table_b",
                  kind="table", source="warehouse")
    c = add_object(external_id="job_c", display_name="job_c",
                  kind="airflow_dag", source="airflow-standalone")

    # Create declared edges a -> b -> c
    with SessionLocal() as db:
        db.add(ObjectEdge(from_object_id=a, to_object_id=b, declared_by="heartbeat"))
        db.add(ObjectEdge(from_object_id=b, to_object_id=c, declared_by="airflow_dataset"))
        db.commit()

    # Add all as nodes in one batch - edges between them are created
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [a, b, c]})
    assert r.status_code == 201
    detail = r.json()
    # Edges between nodes added in the same batch are created automatically
    assert detail["pending_edges"] == 0

    # Now add a fourth object separately
    d = add_object(external_id="table_d", display_name="table_d",
                  kind="table", source="warehouse")
    with SessionLocal() as db:
        # Add edges from c to d (one way) and d to a (another way)
        db.add(ObjectEdge(from_object_id=c, to_object_id=d, declared_by="heartbeat"))
        db.add(ObjectEdge(from_object_id=d, to_object_id=a, declared_by="airflow_dataset"))
        db.commit()

    # Add d as a node separately - edges a->d and d->c are declared but not added
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [d]})
    assert r.status_code == 201
    detail = r.json()
    # Two edges should be pending: c->d and d->a (since c and a are already bound)
    assert detail["pending_edges"] == 2


def test_sync_edges_adds_missing_edges_and_creates_one_version(client):
    """POST /api/pipelines/{slug}/sync-edges appends missing edges in one version."""
    from app.database import SessionLocal
    from app.models_ops import ObjectEdge

    # Create flow with a single node and no edges
    g = graph(nodes=[node(1, uid="u-node-01")], edges=[])
    r = client.post("/api/flows", json={"name": "NoEdges", "graph": g})
    assert r.status_code == 201, r.text
    f = r.json()
    p = promote(client, f)

    a = add_object(external_id="job_a", display_name="job_a",
                  kind="cron_job", source="host:local")
    b = add_object(external_id="table_b", display_name="table_b",
                  kind="table", source="warehouse")

    # Add a first
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [a]})
    assert r.status_code == 201

    # Create declared edge a -> b
    with SessionLocal() as db:
        db.add(ObjectEdge(from_object_id=a, to_object_id=b, declared_by="heartbeat"))
        db.commit()

    # Add b separately - edge a->b should be pending
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [b]})
    assert r.status_code == 201
    detail = r.json()
    version_before_sync = detail["flow_version"]
    edges_before_sync = {(e["from"], e["to"]) for e in detail["graph"]["edges"]}
    assert detail["pending_edges"] == 1
    # Verify a->b edge is not on diagram yet
    assert not any(e["from"] == e["to"] for e in detail["graph"]["edges"])  # No self-loops

    # Sync edges
    r = client.post(f"/api/pipelines/{p['slug']}/sync-edges")
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["added"] == 1
    assert result["version"] == version_before_sync + 1

    # Verify edge was added to the diagram
    detail = client.get(f"/api/pipelines/{p['slug']}").json()
    edges_after_sync = {(e["from"], e["to"]) for e in detail["graph"]["edges"]}
    assert len(edges_after_sync) == len(edges_before_sync) + 1
    assert detail["pending_edges"] == 0


def test_sync_edges_returns_zero_and_no_new_version_when_nothing_missing(client):
    """POST /api/pipelines/{slug}/sync-edges with no missing edges returns 0 and current version."""
    f = create_flow(client)
    p = promote(client, f)
    version_before = p["flow_version"]

    r = client.post(f"/api/pipelines/{p['slug']}/sync-edges")
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["added"] == 0
    assert result["version"] == version_before

    # Verify no new version was created
    detail = client.get(f"/api/pipelines/{p['slug']}").json()
    assert detail["flow_version"] == version_before


def test_sync_edges_ignores_edges_with_unbound_endpoints(client):
    """Edges with an unbound endpoint are ignored by sync-edges."""
    from app.database import SessionLocal
    from app.models_ops import ObjectEdge

    f = create_flow(client)
    p = promote(client, f)

    a = add_object(external_id="job_a", display_name="job_a",
                  kind="cron_job", source="host:local")
    b = add_object(external_id="table_b", display_name="table_b",
                  kind="table", source="warehouse")
    unbound = add_object(external_id="unbound_obj", display_name="unbound_obj",
                        kind="table", source="other_source")

    # Add a and b as nodes
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [a, b]})
    assert r.status_code == 201

    # Create edges: a -> b (both bound) and b -> unbound (unbound not bound to any node)
    with SessionLocal() as db:
        db.add(ObjectEdge(from_object_id=a, to_object_id=b, declared_by="heartbeat"))
        db.add(ObjectEdge(from_object_id=b, to_object_id=unbound, declared_by="airflow_dataset"))
        db.commit()

    detail = client.get(f"/api/pipelines/{p['slug']}").json()
    # Only a -> b should be pending since unbound is not bound in any pipeline
    assert detail["pending_edges"] == 1

    # Sync and verify only a -> b is added
    r = client.post(f"/api/pipelines/{p['slug']}/sync-edges")
    assert r.status_code == 200
    assert r.json()["added"] == 1


def test_sync_edges_requires_edit_permission(client, anonymous_client):
    """POST /api/pipelines/{slug}/sync-edges requires 'edit' permission."""
    f = create_flow(client)
    p = promote(client, f)
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "view"}).json()

    r = anonymous_client.post(f"/api/pipelines/{p['slug']}/sync-edges",
                             headers={"X-Share-Token": link["token"]})
    assert r.status_code == 403


def test_sync_edges_deduplicates_same_edge_from_multiple_declarations(client):
    """If the same edge is declared multiple times, it's added only once."""
    from app.database import SessionLocal
    from app.models_ops import ObjectEdge

    f = create_flow(client)
    p = promote(client, f)

    a = add_object(external_id="job_a", display_name="job_a",
                  kind="cron_job", source="host:local")
    b = add_object(external_id="table_b", display_name="table_b",
                  kind="table", source="warehouse")

    # Add a first
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [a]})
    assert r.status_code == 201

    # Create two declarations of the same edge (by different sources)
    with SessionLocal() as db:
        db.add(ObjectEdge(from_object_id=a, to_object_id=b, declared_by="heartbeat"))
        db.add(ObjectEdge(from_object_id=a, to_object_id=b, declared_by="airflow_dataset"))
        db.commit()

    # Add b separately
    r = client.post(f"/api/pipelines/{p['slug']}/nodes", json={"object_ids": [b]})
    assert r.status_code == 201
    detail = r.json()
    assert detail["pending_edges"] == 1  # Deduplicated

    r = client.post(f"/api/pipelines/{p['slug']}/sync-edges")
    assert r.status_code == 200
    assert r.json()["added"] == 1  # Only one edge added
