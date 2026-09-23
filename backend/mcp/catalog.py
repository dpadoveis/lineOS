"""The tool palette an agent can pick nodes from.

Two sources, the same two the sidebar shows:

* the **built-in** catalog, which lives in `src/flow/constants.js` and is read
  from there rather than copied -- a duplicate list would drift the first time
  someone adds a tool to the editor;
* the **custom** tools registered by users, fetched from `GET /api/tools`.

Only visual fields travel: dropping a tool on the plane copies name, category,
initials and colour into the node, and `tool` keeps just the slug, for the icon
(AGENT.md, trap 11). So a node built from this catalog stays correct even if the
tool is later deleted.
"""
import re
from pathlib import Path

# `{ n: 'Airflow', c: 'ORCHESTRATION', k: 'AF', col: '#7dd3a0', tags: '...' }`
_ENTRY = re.compile(
    r"\{\s*n:\s*'([^']*)'\s*,\s*c:\s*'([^']*)'\s*,\s*k:\s*'([^']*)'\s*,"
    r"\s*col:\s*'([^']*)'\s*,\s*tags:\s*'([^']*)'\s*\}"
)

DEFAULT_COLOR = "#9aa4b0"
DEFAULT_CATEGORY = "CUSTOM"


def constants_path() -> Path:
    """`src/flow/constants.js`, found from this file: backend/mcp -> repo root."""
    return Path(__file__).resolve().parents[2] / "src" / "flow" / "constants.js"


class Catalog:
    """Built-in tools (cached, invalidated by mtime) plus the custom ones."""

    def __init__(self, client, path: Path | None = None):
        self.client = client
        self.path = path or constants_path()
        self._builtin: list[dict] = []
        self._mtime: float | None = None

    def builtin(self) -> list[dict]:
        try:
            mtime = self.path.stat().st_mtime
        except OSError as exc:
            raise RuntimeError(
                f"could not read the built-in catalog at {self.path}: {exc}. "
                "Run the server from inside the repository, or point "
                "FLOW_MCP_CONSTANTS at src/flow/constants.js."
            ) from None
        if self._builtin and self._mtime == mtime:
            return self._builtin

        source = self.path.read_text(encoding="utf-8")
        start = source.find("export const TOOLS")
        block = source[start:] if start >= 0 else source
        end = block.find("];")
        if end >= 0:
            block = block[:end]

        tools = [
            {
                "name": name,
                "category": category,
                "initials": initials,
                "color": color,
                "tags": tags,
                "source": "builtin",
                "slug": None,
            }
            for name, category, initials, color, tags in _ENTRY.findall(block)
        ]
        if not tools:
            raise RuntimeError(
                f"no tool found in {self.path}: the TOOLS array is no longer in the "
                "shape this parser expects."
            )
        self._builtin, self._mtime = tools, mtime
        return tools

    def custom(self) -> list[dict]:
        rows = self.client.request("GET", "/api/tools")
        return [
            {
                "name": row["name"],
                "category": row["category"],
                "initials": row["initials"],
                "color": row["color"],
                "tags": row.get("tags", ""),
                "source": "custom",
                "slug": row["slug"],
                "has_icon": bool(row.get("icon")),
                "id": row["id"],
            }
            for row in rows
        ]

    def all(self, with_custom: bool = True) -> list[dict]:
        tools = list(self.builtin())
        if with_custom:
            try:
                tools += self.custom()
            except Exception:
                # An unreachable API must not take the built-in palette down with
                # it: build_graph works offline, and the caller sees the failure
                # on whatever call actually needed the server.
                pass
        return tools

    def find(self, term: str) -> dict | None:
        """The tool a spec node names: exact name or slug first, then a unique
        case-insensitive match, then a unique prefix."""
        needle = (term or "").strip()
        if not needle:
            return None
        tools = self.all()
        lowered = needle.lower()

        for tool in tools:
            if tool["name"] == needle or tool["slug"] == needle:
                return tool
        exact = [t for t in tools if t["name"].lower() == lowered]
        if len(exact) == 1:
            return exact[0]
        if exact:
            # Two tools with the same name: the built-in one wins, because that
            # is the one the sidebar shows first.
            return next((t for t in exact if t["source"] == "builtin"), exact[0])
        prefix = [t for t in tools if t["name"].lower().startswith(lowered)]
        if len(prefix) == 1:
            return prefix[0]
        return None


def initials_from(name: str) -> str:
    """Same rule as the New tool modal: initials of the first two words, or the
    first two letters of a single one."""
    words = [w for w in name.split() if w]
    if not words:
        return "??"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()
