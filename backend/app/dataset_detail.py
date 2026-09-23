"""Schema, preview, stats and history of one table, safely.

Every identifier is validated against information_schema before it is quoted
with sql.Identifier; every value is a bound parameter. Nothing here writes.
"""
import re
from datetime import date, datetime
from decimal import Decimal

from psycopg import sql

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
OPS = {
    "eq": "{} = %s", "ne": "{} <> %s", "gt": "{} > %s", "gte": "{} >= %s",
    "lt": "{} < %s", "lte": "{} <= %s", "contains": "{}::text ILIKE %s",
    "null": "{} IS NULL", "notnull": "{} IS NOT NULL",
}
NO_VALUE = {"null", "notnull"}
MAX_FILTERS = 5
MAX_CELL = 200


class BadRequest(ValueError):
    pass


def split_external_id(external_id: str) -> tuple[str, str]:
    parts = (external_id or "").split(".")
    if len(parts) != 2 or not all(IDENT.match(p) for p in parts):
        raise BadRequest(f"not a schema.table name: {external_id!r}")
    return parts[0], parts[1]


def columns(conn, schema: str, table: str) -> list[dict]:
    rows = conn.execute(
        "SELECT column_name, data_type, is_nullable = 'YES' FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
        (schema, table),
    ).fetchall()
    return [{"name": r[0], "type": r[1], "nullable": r[2]} for r in rows]


def parse_filters(raw: list[str], known: set[str]) -> list[tuple[str, str, str | None]]:
    if len(raw) > MAX_FILTERS:
        raise BadRequest(f"at most {MAX_FILTERS} filters")
    out = []
    for item in raw:
        parts = item.split(":", 2)
        if len(parts) < 2:
            raise BadRequest(f"filter must be column:op[:value], got {item!r}")
        col, op = parts[0], parts[1]
        value = parts[2] if len(parts) == 3 else None
        if col not in known:
            raise BadRequest(f"unknown column {col!r}")
        if op not in OPS:
            raise BadRequest(f"unknown operator {op!r}")
        if op not in NO_VALUE and value is None:
            raise BadRequest(f"operator {op!r} needs a value")
        if op == "contains":
            value = "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        out.append((col, op, None if op in NO_VALUE else value))
    return out


def default_order(known: set[str], rules: dict) -> str | None:
    fc = (rules or {}).get("freshness_column")
    if fc in known:
        return fc
    return "r_e_c_n_o_" if "r_e_c_n_o_" in known else None


def build_preview(schema, table, order_by, direction, filters, limit):
    where = [sql.SQL(OPS[op]).format(sql.Identifier(col)) for col, op, _ in filters]
    params = [v for _, op, v in filters if op not in NO_VALUE]
    query = sql.SQL("SELECT * FROM {}.{}").format(sql.Identifier(schema), sql.Identifier(table))
    if where:
        query += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(where)
    if order_by:
        query += sql.SQL(" ORDER BY {} {} NULLS LAST").format(
            sql.Identifier(order_by), sql.SQL("ASC" if direction == "asc" else "DESC")
        )
    query += sql.SQL(" LIMIT %s")
    params.append(limit)
    return query, params


def cell(value):
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(value))} bytes>"
    if isinstance(value, (datetime, date)):
        text = value.isoformat()
    elif isinstance(value, Decimal):
        text = format(value, "f")
    else:
        text = str(value)
    return text if len(text) <= MAX_CELL else text[:MAX_CELL] + "…"


def preview(conn, schema, table, rules, order_by, direction, raw_filters, limit):
    cols = columns(conn, schema, table)
    known = {c["name"] for c in cols}
    if order_by and order_by not in known:
        raise BadRequest(f"unknown column {order_by!r}")
    latest = not order_by
    order_by = order_by or default_order(known, rules)
    direction = direction if order_by else None
    if latest and order_by:
        direction = "desc"
    filters = parse_filters(raw_filters, known)
    query, params = build_preview(schema, table, order_by, direction, filters, limit)
    cur = conn.execute(query, params)
    names = [d.name for d in cur.description]
    return {
        "columns": names,
        "rows": [[cell(v) for v in row] for row in cur.fetchall()],
        "ordered_by": order_by,
        "direction": direction,
        "latest": bool(latest and order_by),
        "limit": limit,
    }


def stats(conn, schema, table):
    analyzed = conn.execute(
        "SELECT greatest(last_analyze, last_autoanalyze) FROM pg_stat_user_tables "
        "WHERE schemaname = %s AND relname = %s",
        (schema, table),
    ).fetchone()
    rows = conn.execute(
        "SELECT attname, null_frac, n_distinct, most_common_vals::text::text[], most_common_freqs, "
        "histogram_bounds::text::text[] FROM pg_stats WHERE schemaname = %s AND tablename = %s",
        (schema, table),
    ).fetchall()
    by_name = {r[0]: r for r in rows}
    out = []
    for c in columns(conn, schema, table):
        r = by_name.get(c["name"])
        if r is None:
            out.append({"name": c["name"], "null_frac": None, "n_distinct": None,
                        "most_common": [], "min": None, "max": None})
            continue
        mcv = list(zip(r[3] or [], r[4] or []))[:5]
        bounds = r[5] or []
        out.append({
            "name": c["name"],
            "null_frac": r[1],
            "n_distinct": r[2],
            "most_common": [{"value": cell(v), "freq": f} for v, f in mcv],
            "min": cell(bounds[0]) if bounds else None,
            "max": cell(bounds[-1]) if bounds else None,
        })
    return {"analyzed_at": analyzed[0] if analyzed else None, "columns": out}
