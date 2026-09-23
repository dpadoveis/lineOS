"""Masking secrets out of text that ends up on the ops screen."""
import re

_ENV = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)=(\S+)")
_SECRET_NAME = re.compile(r"(?i)(pass|token|secret|key|dsn)")
_TEXT = re.compile(r"(?i)\b(pass\w*|token|secret|api[_-]?key|dsn)\s*[=:]\s*\S+")


def mask_command(command: str) -> str:
    return _ENV.sub(lambda m: f"{m.group(1)}=***" if _SECRET_NAME.search(m.group(1)) else m.group(0), command)


def mask_text(text):
    if text is None:
        return None
    return _TEXT.sub(lambda m: f"{m.group(1)}=***", str(text))
