"""Thin TMDB v3 client with a token-bucket rate limiter."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

log = logging.getLogger(__name__)

TMDB_BASE = "https://api.themoviedb.org/3"


def _redacted_url(url: httpx.URL) -> str:
    if "api_key" not in url.params:
        return str(url)
    return str(url.copy_set_param("api_key", "<redacted>"))


def _sanitize_http_status_error(exc: httpx.HTTPStatusError) -> httpx.HTTPStatusError:
    response = exc.response
    message = (
        f"HTTP {response.status_code} {response.reason_phrase} for "
        f"{response.request.method} {_redacted_url(response.request.url)}"
    )
    return httpx.HTTPStatusError(message, request=exc.request, response=response)


def _validate_kind(kind: str) -> None:
    if kind not in {"movie", "tv"}:
        raise ValueError(f"unsupported TMDB kind: {kind!r}")


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.RequestError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status == 429 or status >= 500
    return False


class RateLimit:
    """Simple sliding-window limiter: at most ``capacity`` calls per ``window_s``."""

    def __init__(self, capacity: int, window_s: float):
        self.capacity = capacity
        self.window_s = window_s
        self._stamps: list[float] = []
        self._lock: asyncio.Lock | None = None

    async def acquire(self) -> None:
        lock = self._lock
        if lock is None:
            lock = asyncio.Lock()
            self._lock = lock
        while True:
            async with lock:
                now = time.monotonic()
                cutoff = now - self.window_s
                self._stamps = [t for t in self._stamps if t > cutoff]
                if len(self._stamps) < self.capacity:
                    self._stamps.append(now)
                    return
                wait = self._stamps[0] + self.window_s - now
            await asyncio.sleep(max(wait, 0.01))


class TmdbClient:
    def __init__(
        self,
        credential: str,
        *,
        auth_mode: str = "bearer",
        rate_capacity: int = 40,
        rate_window_s: float = 10.0,
        timeout: float = 15.0,
    ):
        self.limiter = RateLimit(rate_capacity, rate_window_s)
        if auth_mode not in {"bearer", "query"}:
            raise ValueError(f"unsupported TMDB auth mode: {auth_mode!r}")
        headers = {"Accept": "application/json"}
        self._api_key = credential if auth_mode == "query" else None
        if auth_mode == "bearer":
            headers["Authorization"] = f"Bearer {credential}"
        self._client = httpx.AsyncClient(
            base_url=TMDB_BASE,
            timeout=timeout,
            headers=headers,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get(self, path: str, **params: Any) -> dict:
        async def _do() -> dict:
            await self.limiter.acquire()
            request_params = dict(params)
            if self._api_key is not None:
                request_params["api_key"] = self._api_key
            r = await self._client.get(path, params=request_params)
            try:
                r.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise _sanitize_http_status_error(exc) from exc
            return r.json()

        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(5),
            wait=wait_exponential(multiplier=0.5, max=8.0),
            retry=retry_if_exception(_is_retryable),
            reraise=True,
        ):
            with attempt:
                return await _do()
        raise RuntimeError("unreachable")

    async def discover(
        self,
        kind: str,
        *,
        page: int,
        vote_count_gte: int,
        year_gte: int | None = None,
        year_lte: int | None = None,
        sort_by: str = "popularity.desc",
    ) -> dict:
        _validate_kind(kind)
        params: dict[str, Any] = {
            "page": page,
            "include_adult": "false",
            "vote_count.gte": vote_count_gte,
            "sort_by": sort_by,
        }
        if kind == "movie":
            if year_gte is not None:
                params["primary_release_date.gte"] = f"{year_gte}-01-01"
            if year_lte is not None:
                params["primary_release_date.lte"] = f"{year_lte}-12-31"
            return await self.get("/discover/movie", **params)
        if year_gte is not None:
            params["first_air_date.gte"] = f"{year_gte}-01-01"
        if year_lte is not None:
            params["first_air_date.lte"] = f"{year_lte}-12-31"
        return await self.get("/discover/tv", **params)

    async def detail(self, kind: str, tmdb_id: int) -> dict:
        _validate_kind(kind)
        if type(tmdb_id) is not int or tmdb_id <= 0:
            raise ValueError(f"unsupported TMDB id: {tmdb_id!r}")
        return await self.get(
            f"/{kind}/{tmdb_id}",
            append_to_response="keywords,credits",
        )

    async def changes(self, kind: str, *, start_date: str, end_date: str, page: int = 1) -> dict:
        _validate_kind(kind)
        return await self.get(
            f"/{kind}/changes", start_date=start_date, end_date=end_date, page=page
        )


def from_env() -> TmdbClient:
    token = os.environ.get("TMDB_READ_ACCESS_TOKEN")
    if token:
        return TmdbClient(token, auth_mode="bearer")
    api_key = os.environ.get("TMDB_API_KEY")
    if api_key:
        return TmdbClient(api_key, auth_mode="query")
    raise RuntimeError("TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY is required")
