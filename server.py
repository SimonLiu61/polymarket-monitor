#!/usr/bin/env python3
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
DEFAULT_WALLET = os.environ.get("POLYMARKET_WALLET", "").strip()

CACHE = {}
CACHE_TTL_SECONDS = 8


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def fetch_json(url, timeout=20):
    now = time.time()
    cached = CACHE.get(url)
    if cached and now - cached["time"] < CACHE_TTL_SECONDS:
        return cached["data"]

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/126 Safari/537.36"
            ),
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    CACHE[url] = {"time": now, "data": data}
    return data


def api_url(base, path, params):
    query = urllib.parse.urlencode(params)
    return f"{base}{path}?{query}"


def number(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def get_account_snapshot(address):
    if not ADDRESS_RE.match(address):
        raise ValueError("Invalid wallet address. Use a 0x-prefixed 40-hex address.")

    value = fetch_json(api_url(DATA_API, "/value", {"user": address}))
    positions = fetch_json(
        api_url(
            DATA_API,
            "/positions",
            {
                "user": address,
                "limit": 500,
                "offset": 0,
                "sizeThreshold": 0,
                "sortBy": "CURRENT",
                "sortDirection": "DESC",
            },
        )
    )
    activity = fetch_json(
        api_url(
            DATA_API,
            "/activity",
            {
                "user": address,
                "limit": 80,
                "offset": 0,
                "sortBy": "TIMESTAMP",
                "sortDirection": "DESC",
            },
        )
    )
    trades = fetch_json(
        api_url(
            DATA_API,
            "/trades",
            {
                "user": address,
                "limit": 80,
                "offset": 0,
                "takerOnly": "false",
            },
        )
    )

    position_value = number(value[0].get("value")) if value else 0.0
    computed_position_value = sum(number(p.get("currentValue")) for p in positions)
    initial_value = sum(number(p.get("initialValue")) for p in positions)
    unrealized_pnl = sum(number(p.get("cashPnl")) for p in positions)
    realized_pnl = sum(number(p.get("realizedPnl")) for p in positions)
    total_bought = sum(number(p.get("totalBought")) for p in positions)
    redeemable_value = sum(number(p.get("currentValue")) for p in positions if p.get("redeemable"))
    mergeable_count = sum(1 for p in positions if p.get("mergeable"))
    largest = max(positions, key=lambda p: number(p.get("currentValue")), default={})

    return {
        "address": address,
        "updatedAt": int(time.time()),
        "summary": {
            "positionValue": position_value or computed_position_value,
            "computedPositionValue": computed_position_value,
            "initialValue": initial_value,
            "unrealizedPnl": unrealized_pnl,
            "realizedPnl": realized_pnl,
            "totalBought": total_bought,
            "positionsCount": len(positions),
            "redeemableValue": redeemable_value,
            "mergeableCount": mergeable_count,
            "largestMarket": {
                "title": largest.get("title", ""),
                "outcome": largest.get("outcome", ""),
                "currentValue": number(largest.get("currentValue")),
                "cashPnl": number(largest.get("cashPnl")),
            },
            "cashBalanceStatus": "not_connected",
        },
        "positions": positions,
        "activity": activity,
        "trades": trades,
    }


def parse_json_list(value):
    if isinstance(value, list):
        return value
    if not isinstance(value, str):
        return []
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def get_settlement_candidates():
    now = time.time()
    params = {
        "limit": 300,
        "active": "true",
        "closed": "false",
        "order": "endDate",
        "ascending": "true",
    }
    markets = fetch_json(api_url(GAMMA_API, "/markets", params), timeout=25)
    candidates = []

    for market in markets:
        end_date = market.get("endDate") or market.get("end_date")
        if not end_date:
            continue
        try:
            end_ts = time.mktime(time.strptime(end_date[:19], "%Y-%m-%dT%H:%M:%S"))
            # API dates are UTC; local mktime is close enough for display ranking only.
            if end_date.endswith("Z"):
                end_ts -= time.timezone
        except ValueError:
            continue

        hours_left = (end_ts - now) / 3600
        if hours_left < 0 or hours_left > 24:
            continue

        prices = [number(x, None) for x in parse_json_list(market.get("outcomePrices"))]
        outcomes = parse_json_list(market.get("outcomes"))
        if len(prices) < 2 or len(outcomes) < 2:
            continue

        best_price = max(prices)
        winner_index = prices.index(best_price)
        liquidity = number(market.get("liquidity"))
        volume = number(market.get("volume"))
        if best_price < 0.55 or best_price > 0.86 or liquidity < 250:
            continue

        hours_score = max(0, 1 - abs(hours_left - 6) / 18)
        price_score = max(0, 1 - abs(best_price - 0.70) / 0.20)
        liquidity_score = min(1, liquidity / 5000)
        score = round(100 * (0.42 * price_score + 0.36 * hours_score + 0.22 * liquidity_score))

        candidates.append(
            {
                "id": market.get("id"),
                "question": market.get("question"),
                "slug": market.get("slug"),
                "endDate": end_date,
                "hoursLeft": round(hours_left, 2),
                "leadingOutcome": outcomes[winner_index],
                "leadingPrice": best_price,
                "liquidity": liquidity,
                "volume": volume,
                "resolutionSource": market.get("resolutionSource", ""),
                "score": score,
            }
        )

    candidates.sort(key=lambda item: item["score"], reverse=True)
    return {"updatedAt": int(time.time()), "candidates": candidates[:60]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/config":
            return json_response(self, 200, {"defaultWallet": DEFAULT_WALLET})

        if parsed.path == "/api/account":
            address = (query.get("address") or [DEFAULT_WALLET])[0].strip()
            try:
                return json_response(self, 200, get_account_snapshot(address))
            except ValueError as exc:
                return json_response(self, 400, {"error": str(exc)})
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:500]
                return json_response(
                    self,
                    exc.code,
                    {"error": "Polymarket API rejected the request.", "detail": detail},
                )
            except Exception as exc:
                return json_response(self, 502, {"error": str(exc)})

        if parsed.path == "/api/settlement-candidates":
            try:
                return json_response(self, 200, get_settlement_candidates())
            except Exception as exc:
                return json_response(self, 502, {"error": str(exc)})

        return super().do_GET()


def main():
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Polymarket monitor running at http://127.0.0.1:{port}")
    print("Set POLYMARKET_WALLET=0x... before launch to prefill your account.")
    server.serve_forever()


if __name__ == "__main__":
    main()
