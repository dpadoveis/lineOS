"""HTTP client for the Editor de Fluxo API, on the standard library alone.

No third-party package on purpose: this server has to start from a bare
`python3`, and the host it runs on has neither pip nor a virtualenv.

The API authenticates with an httpOnly session cookie (backend/app/routers/
auth.py), so the client keeps a cookie jar and signs in lazily -- on the first
call that needs an account, and again whenever a call comes back 401 because
the session expired or the password was changed elsewhere.
"""
import http.cookiejar
import json
import threading
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "http://127.0.0.1:8010"
DEFAULT_TIMEOUT = 20.0


class ApiError(Exception):
    """An API answer that is not a success, or a transport failure (status 0)."""

    def __init__(self, status: int, detail, path: str = ""):
        self.status = status
        self.detail = detail
        self.path = path
        super().__init__(self.message())

    def message(self) -> str:
        detail = self.detail
        if isinstance(detail, dict):
            detail = detail.get("message") or json.dumps(
                detail, ensure_ascii=False
            )
        elif isinstance(detail, list):
            # FastAPI validation errors: keep the field path and the reason.
            parts = []
            for item in detail:
                if isinstance(item, dict):
                    where = ".".join(str(p) for p in item.get("loc", [])[1:])
                    parts.append(f"{where}: {item.get('msg', '')}".strip(": "))
                else:
                    parts.append(str(item))
            detail = "; ".join(parts)
        where = f" ({self.path})" if self.path else ""
        if self.status == 0:
            return f"{detail}{where}"
        return f"HTTP {self.status}{where}: {detail}"


class ApiClient:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        email: str | None = None,
        password: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        self.email = (email or "").strip()
        self.password = password or ""
        self.timeout = timeout
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._lock = threading.Lock()
        self._user: dict | None = None
        self._smtp_ready = False

    # ── Session ──────────────────────────────────────────────────────

    @property
    def user(self) -> dict | None:
        return self._user

    def sign_in(self) -> dict:
        """Opens a session with the configured credentials."""
        if not self.email or not self.password:
            raise ApiError(
                401,
                "no credentials configured: set FLOW_MCP_EMAIL and FLOW_MCP_PASSWORD "
                f"for an account on {self.base_url}",
            )
        info = self._send(
            "POST",
            "/api/auth/login",
            body={"email": self.email, "password": self.password},
            authenticate=False,
        )
        self._user = info.get("user")
        self._smtp_ready = bool(info.get("smtp_ready"))
        return info

    def ensure_session(self) -> None:
        with self._lock:
            if self._user is not None:
                return
            info = self._send("GET", "/api/auth/me", authenticate=False)
            if info.get("user"):
                self._user = info["user"]
                self._smtp_ready = bool(info.get("smtp_ready"))
                return
            self.sign_in()

    def whoami(self) -> dict:
        self.ensure_session()
        return {
            "base_url": self.base_url,
            "user": self._user,
            "smtp_ready": self._smtp_ready,
        }

    def health(self) -> dict:
        return self._send("GET", "/api/health", authenticate=False)

    # ── Requests ─────────────────────────────────────────────────────

    def request(self, method: str, path: str, body=None, params: dict | None = None):
        return self._send(method, path, body=body, params=params, authenticate=True)

    def _send(
        self,
        method: str,
        path: str,
        body=None,
        params: dict | None = None,
        authenticate: bool = True,
        _retried: bool = False,
    ):
        if authenticate:
            self.ensure_session()

        url = self.base_url + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)

        data = None
        request = urllib.request.Request(url, method=method)
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            request.data = data
            request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")

        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return _decode(response)
        except urllib.error.HTTPError as exc:
            payload = _decode(exc)
            detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
            # A 401 on a call we thought was authenticated means the session died
            # (expired, or every session was closed by a password change). One
            # fresh sign-in, then give up -- looping would just hammer the API.
            if exc.code == 401 and authenticate and not _retried and self.email:
                self._user = None
                self.sign_in()
                return self._send(
                    method, path, body=body, params=params, authenticate=False, _retried=True
                )
            raise ApiError(exc.code, detail, path) from None
        except urllib.error.URLError as exc:
            raise ApiError(
                0, f"could not reach the API at {self.base_url}: {exc.reason}", path
            ) from None
        except TimeoutError:
            raise ApiError(0, f"the API at {self.base_url} timed out", path) from None


def _decode(response):
    raw = response.read()
    if not raw:
        return {}
    text = raw.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"detail": text.strip()[:500]}
