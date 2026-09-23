"""Password hashing and opaque tokens, on the standard library only.

The project keeps its dependency list short on purpose (see AGENT.md), and
PBKDF2-HMAC-SHA256 from `hashlib` is a sound password hash when the iteration
count is high enough -- `settings.password_iterations`, currently 210k, the
figure OWASP recommends for SHA-256.

The stored string is `pbkdf2_sha256$<iterations>$<salt>$<digest>`, both parts in
base64. Because the cost travels inside it, raising the setting later only
affects new hashes; the old ones keep verifying at their own cost.
"""
import base64
import hashlib
import hmac
import secrets

from .config import settings

_ALGO = "pbkdf2_sha256"
_SALT_BYTES = 16
_TOKEN_BYTES = 32


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_BYTES)
    iterations = settings.password_iterations
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"{_ALGO}${iterations}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check. A malformed stored hash is a failure, never a crash."""
    try:
        algo, iterations, salt_b64, digest_b64 = stored.split("$", 3)
        if algo != _ALGO:
            return False
        esperado = base64.b64decode(digest_b64)
        obtido = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt_b64), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(esperado, obtido)


def new_token() -> str:
    """Raw token for a session cookie or a share link. Shown once, never stored."""
    return secrets.token_urlsafe(_TOKEN_BYTES)


def token_hash(token: str) -> str:
    """What goes to the database. A plain sha256 is enough here: the token is
    256 bits of entropy, so there is nothing to brute-force."""
    return hashlib.sha256(token.encode()).hexdigest()
