"""Credential-like query values never reach the server log or the database (docs/VAULT.md).

Clients that cannot set headers (the claude.ai custom connector) send the workspace token as `/mcp?token=<token>` on
every request, and the room big screen opens `/room/{code}?token=<token>` (docs/MCP.md, docs/ROOM.md). uvicorn's access
log prints each path with its query string, so without the filter below every such request wrote the bearer token to
`flyctl logs`. The same key rule keeps sign-in query values (a session token, a one-time code) out of the URLs Pulse
stores for a profile or a post.
"""

import logging
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ACCESS_LOGGER = "uvicorn.access"
REDACTED = "[redacted]"

# A query key that names a token, a password, a one-time code, a cookie, a session or a secret.
_KEY = (
    r"(?:[\w.\-\[\]]*(?:token|passw|passcode|otp|secret|session|cookie|csrf|credential)[\w.\-\[\]]*"
    r"|auth|authorization)"
)
_CREDENTIAL_KEY = re.compile(rf"^{_KEY}$", re.IGNORECASE)
_SECRET_QUERY = re.compile(rf"([?&;]{_KEY}=)[^&;#\s\"]*", re.IGNORECASE)


def is_credential_key(name: str) -> bool:
    return bool(_CREDENTIAL_KEY.match(name.strip()))


def redact(text: str) -> str:
    """`text` with the value of every credential-like query parameter replaced by `[redacted]`."""
    return _SECRET_QUERY.sub(lambda m: m.group(1) + REDACTED, text)


def has_credential_query(url: str) -> bool:
    try:
        query = urlsplit(url).query
    except ValueError:
        return False
    return any(is_credential_key(k) for k, _ in parse_qsl(query, keep_blank_values=True))


def strip_credential_query(url: str) -> str:
    """`url` without its credential-like query parameters; every other part is kept as it was."""
    if not has_credential_query(url):
        return url
    parts = urlsplit(url)
    keep = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not is_credential_key(k)]
    return urlunsplit(parts._replace(query=urlencode(keep)))


class RedactQuery(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
        return True


def install_log_filter() -> None:
    """Attach the filter to uvicorn's access logger once. dictConfig keeps logger filters, so order does not matter."""
    logger = logging.getLogger(ACCESS_LOGGER)
    if not any(isinstance(f, RedactQuery) for f in logger.filters):
        logger.addFilter(RedactQuery())
