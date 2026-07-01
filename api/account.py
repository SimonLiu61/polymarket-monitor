import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler


DATA_API = "https://data-api.polymarket.com"
ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


def fetch_json(url, timeout=20):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/126 Safari/537.36"
            ),
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def api_url(path, params):
    return f"{DATA_API}{path}?{urllib.parse.urlencode(params)}"


def number(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def account_snapshot(address):
    if not ADDRESS_RE.match(address):
        return 400, {"error": "Invalid wallet address. Use a 0x-prefixed 40-hex address."}

    value = fetch_json(api_url("/value", {"user": address}))
    positions = fetch_json(
        api_url(
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

    return 200, {
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


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        address = (params.get("address") or [""])[0].strip()

        try:
            status, payload = account_snapshot(address)
        except urllib.error.HTTPError as exc:
            status = exc.code
            payload = {"error": "Polymarket API rejected the request."}
        except Exception as exc:
            status = 502
            payload = {"error": str(exc)}

        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
