"""In-process sliding-window rate limiter.

Good enough for a single backend process. For multiple replicas, put a shared limiter
(e.g. Redis or the reverse proxy) in front.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, limit: int, window_s: float = 60.0) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        if len(self._hits) > 50_000:  # bound memory under key churn
            for k in [k for k, v in self._hits.items() if not v or now - v[-1] > window_s][:10_000]:
                del self._hits[k]
        return True

    def retry_after(self, key: str, window_s: float = 60.0) -> int:
        q = self._hits.get(key)
        if not q:
            return 1
        return max(1, int(window_s - (time.monotonic() - q[0])) + 1)


limiter = RateLimiter()
