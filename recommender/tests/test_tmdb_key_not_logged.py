"""2026-10-16 review item 22: TMDB v3 auth rides the query string, and httpx
logs every request URL at INFO, so the api_key landed in the logs."""

import asyncio
import logging

import httpx

from workers.tmdb_client import TmdbClient


def test_api_key_never_reaches_the_httpx_request_log(caplog) -> None:
    client = TmdbClient("SECRETKEY123", auth_mode="query")
    client._client = httpx.AsyncClient(
        base_url="https://api.themoviedb.org/3",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
    )

    async def go() -> None:
        await client.get("/movie/1")
        await client.aclose()

    with caplog.at_level(logging.INFO, logger="httpx"):
        asyncio.run(go())

    assert "HTTP Request" in caplog.text
    assert "SECRETKEY123" not in caplog.text
