import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler


GAMMA_API = "https://gamma-api.polymarket.com"


def fetch_json(url, timeout=25):
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
    return f"{GAMMA_API}{path}?{urllib.parse.urlencode(params)}"


def number(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


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


def parse_end_ts(value):
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return None


def settlement_candidates():
    markets = fetch_json(
        api_url(
            "/markets",
            {
                "limit": 300,
                "active": "true",
                "closed": "false",
                "order": "endDate",
                "ascending": "true",
            },
        )
    )
    now = datetime.now(timezone.utc).timestamp()
    candidates = []

    for market in markets:
        end_date = market.get("endDate") or market.get("end_date")
        end_ts = parse_end_ts(end_date)
        if end_ts is None:
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


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            status = 200
            payload = settlement_candidates()
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
