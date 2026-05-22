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
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

log = logging.getLogger(__name__)

TMDB_BASE = "https://api.themoviedb.org/3"


class RateLimit:
    """Simple sliding-window limiter: at most ``capacity`` calls per ``window_s``."""

    def __init__(self, capacity: int, window_s: float):
        self.capacity = capacity
        self.window_s = window_s
        self._stamps: list[float] = []
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
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
        api_key: str,
        *,
        rate_capacity: int = 40,
        rate_window_s: float = 10.0,
        timeout: float = 15.0,
    ):
        self.api_key = api_key
        self.limiter = RateLimit(rate_capacity, rate_window_s)
        self._client = httpx.AsyncClient(
            base_url=TMDB_BASE,
            timeout=timeout,
            headers={"Accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get(self, path: str, **params: Any) -> dict:
        params = {"api_key": self.api_key, **params}

        async def _do() -> dict:
            await self.limiter.acquire()
            r = await self._client.get(path, params=params)
            if r.status_code == 429:
                retry_after = float(r.headers.get("Retry-After", "1"))
                await asyncio.sleep(retry_after)
                raise httpx.HTTPStatusError("429", request=r.request, response=r)
            r.raise_for_status()
            return r.json()

        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(5),
            wait=wait_exponential(multiplier=0.5, max=8.0),
            retry=retry_if_exception_type((httpx.HTTPStatusError, httpx.RequestError)),
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
        return await self.get(
            f"/{kind}/{tmdb_id}",
            append_to_response="keywords,credits",
        )

    async def changes(self, kind: str, *, start_date: str, end_date: str, page: int = 1) -> dict:
        return await self.get(
            f"/{kind}/changes", start_date=start_date, end_date=end_date, page=page
        )


def from_env() -> TmdbClient:
    key = os.environ.get("TMDB_API_KEY")
    if not key:
        raise RuntimeError("TMDB_API_KEY is required")
    return TmdbClient(key)
