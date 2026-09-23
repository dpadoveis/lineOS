#!/usr/bin/env python3
"""End-to-end check of the MCP server, over stdio, the way a client drives it.

    python3 backend/mcp/selftest.py

The protocol half (handshake, tools/list, build_graph, error reporting) runs
anywhere -- it touches no server. The round trip half only runs when
FLOW_MCP_EMAIL and FLOW_MCP_PASSWORD are set, and it **writes for real**:
it creates a flow, versions it, restores it and deletes it permanently. Point
it at a disposable API, never at the production one -- e2e/README.md has the
throwaway API on 8011.

    FLOW_MCP_BASE_URL=http://127.0.0.1:8011 \\
    FLOW_MCP_EMAIL=mcp@teste.local FLOW_MCP_PASSWORD=... \\
      python3 backend/mcp/selftest.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent / "server.py"
FLOW_NAME = "MCP selftest flow"


class Client:
    """A minimal MCP client: one process, one request at a time."""

    def __init__(self, env: dict):
        self.process = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, **env},
        )
        self.counter = 0

    def send(self, method: str, params=None, notify: bool = False):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if not notify:
            self.counter += 1
            message["id"] = self.counter
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        if notify:
            return None
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError(f"server closed stdout; stderr:\n{self.process.stderr.read()}")
        answer = json.loads(line)
        if "error" in answer:
            raise AssertionError(f"{method} failed: {answer['error']}")
        return answer["result"]

    def call(self, name: str, arguments=None, expect_error: bool = False):
        result = self.send("tools/call", {"name": name, "arguments": arguments or {}})
        text = result["content"][0]["text"]
        if result.get("isError"):
            if expect_error:
                return text
            raise AssertionError(f"{name} answered an error: {text}")
        if expect_error:
            raise AssertionError(f"{name} was expected to fail, but answered: {text[:200]}")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)


def step(text: str) -> None:
    print(f"  {text}", flush=True)


def protocol_checks(env: dict) -> None:
    print("protocol")
    client = Client(env)
    try:
        info = client.send("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "selftest", "version": "1.0"},
        })
        assert info["protocolVersion"] == "2025-06-18", info
        assert info["serverInfo"]["name"] == "lineos", info
        assert "tools" in info["capabilities"], info
        step("initialize negotiates and announces the tools capability")

        client.send("notifications/initialized", {}, notify=True)
        assert client.send("ping") == {}
        step("ping answers")

        tools = client.send("tools/list")["tools"]
        names = {t["name"] for t in tools}
        assert {"build_graph", "create_flow", "get_flow", "list_catalog"} <= names, names
        for tool in tools:
            assert tool["description"] and tool["inputSchema"]["type"] == "object", tool
        step(f"tools/list returns {len(tools)} tools, all with a schema")

        catalog = client.call("list_catalog", {"query": "kafka", "custom": False})
        assert catalog["count"] == 1 and catalog["tools"][0]["initials"] == "KF", catalog
        step("list_catalog reads the built-in palette from src/flow/constants.js")

        built = client.call("build_graph", {
            "nodes": [
                {"tool": "Kafka", "key": "in", "label": "Orders topic"},
                {"tool": "Airflow", "key": "run", "metadata": {"schedule": "0 3 * * *"}},
                {"tool": "Snowflake", "key": "out"},
            ],
            "edges": [
                {"from": "in", "to": "run", "label": "events"},
                {"from": "run", "to": "out", "label": "load"},
            ],
        })["graph"]
        assert built["kind"] == "flow-graph" and built["version"] == 1, built
        assert [n["id"] for n in built["nodes"]] == [1, 2, 3], built
        assert [e["id"] for e in built["edges"]] == [1, 2], built
        assert built["nodes"][0]["color"] == "#a78bd8", built["nodes"][0]
        assert built["nodes"][0]["label"] == "Orders topic", built["nodes"][0]
        assert built["nodes"][1]["metadata"] == {"schedule": "0 3 * * *"}, built["nodes"][1]
        # Layered left to right, and each node lands on the 24 px grid.
        xs = [n["x"] for n in built["nodes"]]
        assert xs[0] < xs[1] < xs[2], xs
        assert all(n["x"] % 24 == 0 and n["y"] % 24 == 0 for n in built["nodes"]), built
        step("build_graph lays out three layers, keeps the palette colours and the grid")

        fixed = client.call("build_graph", {
            "nodes": [
                {"tool": "dbt", "x": 0, "y": 96},
                {"tool": "Looker", "x": 480, "y": -96},
            ],
            "edges": [{"from": 1, "to": 2}],
        })["graph"]
        assert [(n["x"], n["y"]) for n in fixed["nodes"]] == [(0, 96), (480, -96)], fixed
        step("explicit coordinates survive the round trip, y upwards as in the JSON format")

        message = client.call("build_graph", {
            "nodes": [{"tool": "Airflow"}, {"tool": "dbt"}],
            "edges": [{"from": 1, "to": 1}],
        }, expect_error=True)
        assert "itself" in message, message
        message = client.call("build_graph", {"nodes": [{"tool": "Nonesuch"}]}, expect_error=True)
        assert "catalog" in message, message
        step("bad specs come back as readable tool errors, not crashes")

        message = client.call("no_such_tool", expect_error=True)
        assert "no tool named" in message, message
        step("an unknown tool is an error result, not a dead server")
    finally:
        client.close()


def read_only_check(env: dict) -> None:
    print("read-only mode")
    client = Client({**env, "FLOW_MCP_READ_ONLY": "true"})
    try:
        client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "selftest", "version": "1.0"}})
        names = {t["name"] for t in client.send("tools/list")["tools"]}
        assert "create_flow" not in names and "trash_flow" not in names, names
        assert "get_flow" in names and "build_graph" in names, names
        step(f"only the {len(names)} reading tools are listed")
        message = client.call("create_flow", {"name": "nope"}, expect_error=True)
        assert "read-only" in message, message
        step("calling a writing tool anyway is refused")
    finally:
        client.close()


def round_trip(env: dict) -> None:
    print(f"round trip against {env.get('FLOW_MCP_BASE_URL')}")
    client = Client(env)
    reference = None
    try:
        client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "selftest", "version": "1.0"}})
        status = client.call("server_status")
        assert status["api"]["status"] == "ok", status
        assert status["user"], status
        step(f"signed in as {status['user']['email']}")

        tool = client.call("create_custom_tool", {
            "name": "Selftest Warehouse", "category": "storage",
            "color": "#6fd3c7", "tags": "selftest",
        })
        assert tool["slug"] == "selftest-warehouse" and tool["initials"] == "SW", tool
        assert tool["category"] == "STORAGE", tool
        found = client.call("list_catalog", {"query": "selftest"})
        assert found["count"] == 1 and found["tools"][0]["source"] == "custom", found
        custom = client.call("build_graph", {"nodes": [{"tool": "Selftest Warehouse"}]})["graph"]
        # Only the icon is resolved through `tool` later; the visual fields are
        # copied into the node, so deleting the tool never rewrites a graph.
        assert custom["nodes"][0]["tool"] == "selftest-warehouse", custom
        assert custom["nodes"][0]["color"] == "#6fd3c7", custom
        # Nothing was saved, so nothing uses it -- which is what lets it go.
        usage = client.call("tool_usage", {"slug": tool["slug"], "name": tool["name"]})
        assert usage["count"] == 0, usage
        client.call("delete_custom_tool", {"id": tool["id"]})
        assert client.call("list_catalog", {"query": "selftest"})["count"] == 0
        step("create_custom_tool registers a tool, build_graph resolves it, "
             "tool_usage finds it unused and delete removes it")

        created = client.call("create_flow", {
            "name": FLOW_NAME,
            "description": "written by backend/mcp/selftest.py",
            "note": "first version",
            "nodes": [
                {"tool": "Fivetran", "key": "src", "description": "daily pull"},
                {"tool": "dbt", "key": "model"},
                {"tool": "Metabase", "key": "bi"},
            ],
            "edges": [{"from": "src", "to": "model", "label": "raw"},
                      {"from": "model", "to": "bi", "label": "marts"}],
        })
        reference = created["slug"]
        assert created["current_version"] == 1 and created["node_count"] == 3, created
        step(f"create_flow wrote {reference} at version 1")

        opened = client.call("get_flow", {"reference": reference})
        assert opened["graph"]["nodes"][1]["name"] == "dbt", opened["graph"]["nodes"][1]
        assert opened["graph_source"] == "version", opened
        step("get_flow returns the stored graph")

        graph = opened["graph"]
        graph["nodes"][2]["label"] = "Dashboards"
        versioned = client.call("save_version", {
            "reference": reference, "graph": graph, "note": "renamed the BI node",
            "base_version": opened["current_version"],
        })
        assert versioned["version"] == 2, versioned
        step("save_version wrote version 2 from base_version 1")

        message = client.call("save_version", {
            "reference": reference, "graph": graph, "base_version": 1,
        }, expect_error=True)
        assert "409" in message, message
        step("a stale base_version is refused with 409, as in the editor")

        client.call("save_draft", {
            "reference": reference,
            "nodes": [{"tool": "Kafka", "label": "draft only"}],
        })
        drafted = client.call("get_flow", {"reference": reference, "graph": "summary"})
        assert drafted["graph_source"] == "draft", drafted
        assert drafted["has_draft"], drafted
        versions = client.call("list_versions", {"reference": reference})
        assert versions["count"] == 2, versions
        step("save_draft changes what opens without adding a version")

        restored = client.call("restore_version", {"reference": reference, "version": 1})
        assert restored["version"] == 3, restored
        assert client.call("get_version", {"reference": reference, "version": 1})["graph"][
            "nodes"
        ][2].get("label") is None
        step("restore_version added version 3 and left version 1 untouched")

        renamed = client.call("rename_flow", {"reference": reference, "name": FLOW_NAME + " (renamed)"})
        reference = renamed["slug"]
        step(f"rename_flow moved the slug to {reference}")

        client.call("trash_flow", {"reference": reference})
        assert client.call("list_flows", {"trashed": True})["count"] >= 1
        client.call("restore_flow", {"reference": reference})
        step("trash and restore work")

        message = client.call("trash_flow", {"reference": reference, "permanent": True},
                              expect_error=True)
        assert "confirm" in message, message
        client.call("trash_flow", {"reference": reference, "permanent": True,
                                   "confirm": reference})
        assert not any(
            f["slug"] == reference for f in client.call("list_flows", {})["flows"]
        )
        reference = None
        step("permanent delete needs the confirmation, then really deletes")
    finally:
        if reference:
            try:
                client.call("trash_flow", {"reference": reference, "permanent": True,
                                           "confirm": reference})
                step(f"cleaned up {reference}")
            except Exception as exc:  # best effort
                print(f"  could not clean up {reference}: {exc}", file=sys.stderr)
        client.close()


def main() -> int:
    env = {k: v for k, v in os.environ.items() if k.startswith("FLOW_MCP_")}
    protocol_checks(env)
    read_only_check(env)
    if env.get("FLOW_MCP_EMAIL") and env.get("FLOW_MCP_PASSWORD"):
        target = env.get("FLOW_MCP_BASE_URL", "")
        # The round trip creates and deletes real flows. 8010 is where the
        # stack's own API listens (docker-compose.yml), so it takes a deliberate
        # opt-in.
        if (not target or ":8010" in target) and not os.environ.get("FLOW_MCP_ALLOW_PROD"):
            print("round trip skipped: FLOW_MCP_BASE_URL points at the stack's API "
                  "(:8010). Start the disposable one from e2e/README.md, or set "
                  "FLOW_MCP_ALLOW_PROD=1 to insist.", file=sys.stderr)
            print("\nok")
            return 0
        round_trip(env)
    else:
        print("round trip skipped: set FLOW_MCP_EMAIL and FLOW_MCP_PASSWORD "
              "(against a disposable API) to run it")
    print("\nok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
