#!/usr/bin/env python3
"""MCP server for lineOS.

Speaks the Model Context Protocol over stdio, so an MCP client (Claude Code,
Claude Desktop, anything else) can list, read, create and version the diagrams
of one account. Every write goes through the HTTP API, so the permissions,
validation and optimistic locking that guard the editor guard this too.

Standard library only, on purpose: the machine this runs on has no pip and no
virtualenv, and a server that needs an install is a server that is not there
when the client starts it. The protocol itself is a small line-delimited
JSON-RPC 2.0 loop -- initialize, tools/list, tools/call, ping.

    python3 backend/mcp/server.py            # what the MCP client launches
    python3 backend/mcp/server.py --check    # smoke test, no client involved

Configuration is environment (see backend/mcp/README.md):

    FLOW_MCP_BASE_URL   API address (default http://127.0.0.1:8010)
    FLOW_MCP_EMAIL      account to act as
    FLOW_MCP_PASSWORD   its password
    FLOW_MCP_READ_ONLY  drops every writing tool when set
"""
import argparse
import json
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import toolset  # noqa: E402
from catalog import Catalog  # noqa: E402
from client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, ApiClient, ApiError  # noqa: E402
from graph import SpecError  # noqa: E402

SERVER_NAME = "lineos"
SERVER_VERSION = "1.0.0"

# Newest first. The client's own version is echoed back when we know it,
# otherwise the negotiation settles on the newest we speak.
SUPPORTED_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

INSTRUCTIONS = """\
Visual editor for data architecture diagrams. A flow is a graph of tool nodes
joined by labelled arrows, stored with an immutable version history.

Usual order of work: list_catalog to see the palette, build_graph to turn a
short spec into a valid payload, then create_flow (new diagram) or save_version
(new version of an existing one). To change a diagram, get_flow first -- edit
the graph it returns and send it back, so nothing you did not touch is lost.

Ids are local to each document and nodes and edges number separately. The y
axis grows upwards in the payload. build_graph handles both; hand-written
graphs must respect them.\
"""


def load_env_file(path: Path | None = None) -> None:
    """Fills in the FLOW_MCP_* variables from the project's .env.

    An MCP client starts this server itself, with whatever environment it
    happens to have, so asking the user to export a password before launching
    their editor would not work. The .env at the repository root is already the
    place this project keeps secrets, and it is already gitignored.

    A real environment variable always wins, and nothing outside the FLOW_MCP_
    prefix is read -- the database password in that file is none of our
    business.
    """
    target = path or Path(__file__).resolve().parents[2] / ".env"
    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key.startswith("FLOW_MCP_") or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


class Server:
    def __init__(self, context: toolset.Context, debug: bool = False):
        self.context = context
        self.debug = debug
        self.protocol = SUPPORTED_PROTOCOLS[0]

    # ── Transport ────────────────────────────────────────────────────

    def run(self, stream_in=sys.stdin, stream_out=sys.stdout) -> int:
        self.log(f"listening on stdio (api={self.context.client.base_url})")
        for line in stream_in:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                self.write(stream_out, _error(None, -32700, f"parse error: {exc}"))
                continue
            # JSON-RPC batches: gone from the 2025-06-18 protocol, still cheap
            # to accept from an older client.
            for one in message if isinstance(message, list) else [message]:
                answer = self.handle(one)
                if answer is not None:
                    self.write(stream_out, answer)
        self.log("stdin closed, exiting")
        return 0

    def write(self, stream_out, payload: dict) -> None:
        stream_out.write(json.dumps(payload, ensure_ascii=False) + "\n")
        stream_out.flush()

    def log(self, text: str) -> None:
        # stdout carries the protocol; anything we say goes to stderr.
        print(f"[{SERVER_NAME}] {text}", file=sys.stderr, flush=True)

    # ── Dispatch ─────────────────────────────────────────────────────

    def handle(self, message) -> dict | None:
        if not isinstance(message, dict):
            return _error(None, -32600, "invalid request")
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") or {}

        # A notification has no id and must never be answered.
        if request_id is None:
            if method == "notifications/initialized":
                self.log("client ready")
            return None

        try:
            if method == "initialize":
                return _result(request_id, self.initialize(params))
            if method == "tools/list":
                return _result(request_id, {"tools": toolset.listing(self.context.read_only)})
            if method == "tools/call":
                return _result(request_id, self.call(params))
            if method == "ping":
                return _result(request_id, {})
            return _error(request_id, -32601, f"method not found: {method}")
        except Exception as exc:  # protocol-level failure, not a tool failure
            self.log(traceback.format_exc())
            return _error(request_id, -32603, f"internal error: {exc}")

    def initialize(self, params: dict) -> dict:
        asked = params.get("protocolVersion")
        self.protocol = asked if asked in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
        client = params.get("clientInfo") or {}
        self.log(f"initialize from {client.get('name', 'unknown')} (protocol {self.protocol})")
        return {
            "protocolVersion": self.protocol,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": INSTRUCTIONS,
        }

    def call(self, params: dict) -> dict:
        name = params.get("name")
        arguments = params.get("arguments") or {}
        tool = toolset.BY_NAME.get(name)

        if tool is None:
            return _tool_error(f"no tool named {name!r}")
        if tool["write"] and self.context.read_only:
            return _tool_error(
                f"{name} writes, and this server is running read-only "
                "(FLOW_MCP_READ_ONLY). Unset it to allow changes."
            )
        if not isinstance(arguments, dict):
            return _tool_error("`arguments` must be an object")

        try:
            payload = tool["handler"](self.context, arguments)
        except ApiError as exc:
            return _tool_error(exc.message())
        except (SpecError, ValueError) as exc:
            return _tool_error(str(exc))
        except RuntimeError as exc:
            return _tool_error(str(exc))
        except Exception as exc:
            self.log(traceback.format_exc())
            return _tool_error(f"unexpected failure in {name}: {exc}")

        text = (
            payload
            if isinstance(payload, str)
            else json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        )
        return {"content": [{"type": "text", "text": text}], "isError": False}


def _result(request_id, payload: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def _error(request_id, code: int, text: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": text}}


def _tool_error(text: str) -> dict:
    """A tool that failed is a successful call with isError -- the model has to
    see the message to fix its arguments."""
    return {"content": [{"type": "text", "text": text}], "isError": True}


def build_context(args) -> toolset.Context:
    client = ApiClient(
        base_url=args.base_url,
        email=args.email,
        password=os.environ.get("FLOW_MCP_PASSWORD", ""),
        timeout=args.timeout,
    )
    override = os.environ.get("FLOW_MCP_CONSTANTS")
    catalog = Catalog(client, Path(override) if override else None)
    return toolset.Context(client, catalog, read_only=args.read_only)


def check(context: toolset.Context) -> int:
    """Smoke test: what the client would see, printed for a human."""
    status = toolset.server_status(context, {})
    print(json.dumps(status, ensure_ascii=False, indent=2, default=str))
    tools = toolset.listing(context.read_only)
    print(f"\n{len(tools)} tool(s) exposed: {', '.join(t['name'] for t in tools)}")
    if not status.get("user"):
        print("\nNot signed in. Set FLOW_MCP_EMAIL and FLOW_MCP_PASSWORD.", file=sys.stderr)
        return 1
    return 0


def main(argv=None) -> int:
    load_env_file()
    parser = argparse.ArgumentParser(description="MCP server for lineOS.")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("FLOW_MCP_BASE_URL", DEFAULT_BASE_URL),
        help="API address (default: %(default)s)",
    )
    parser.add_argument(
        "--email",
        default=os.environ.get("FLOW_MCP_EMAIL", ""),
        help="account to act as; the password comes from FLOW_MCP_PASSWORD",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("FLOW_MCP_TIMEOUT", DEFAULT_TIMEOUT)),
        help="seconds to wait on each API call (default: %(default)s)",
    )
    parser.add_argument(
        "--read-only",
        action="store_true",
        default=truthy(os.environ.get("FLOW_MCP_READ_ONLY")),
        help="expose only the tools that read",
    )
    parser.add_argument(
        "--check", action="store_true", help="print status and the tool list, then exit"
    )
    args = parser.parse_args(argv)

    context = build_context(args)
    if args.check:
        return check(context)
    return Server(context, debug=truthy(os.environ.get("FLOW_MCP_DEBUG"))).run()


if __name__ == "__main__":
    sys.exit(main())
