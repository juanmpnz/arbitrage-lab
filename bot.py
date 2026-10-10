"""Public-data triangular arbitrage research. No order or account endpoints."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from decimal import Decimal as D
import json
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

BASE = "https://data-api.binance.vision/api/v3/"


@dataclass(frozen=True)
class Edge:
    symbol: str
    source: str
    target: str
    rate: D
    capacity: D  # units of source currency at best price


def graph(markets: list[dict], quotes: list[dict]) -> dict[str, dict[str, Edge]]:
    books = {q["symbol"]: q for q in quotes}
    result: dict[str, dict[str, Edge]] = {}
    for m in markets:
        if m.get("status") != "TRADING" or not m.get("isSpotTradingAllowed", False):
            continue
        q = books.get(m["symbol"])
        if not q:
            continue
        bid, ask, bq, aq = (D(q[k]) for k in ("bidPrice", "askPrice", "bidQty", "askQty"))
        if not all(v.is_finite() and v > 0 for v in (bid, ask, bq, aq)) or bid > ask:
            continue
        b, a = m["baseAsset"], m["quoteAsset"]
        result.setdefault(b, {})[a] = Edge(m["symbol"], b, a, bid, bq)
        result.setdefault(a, {})[b] = Edge(m["symbol"], a, b, 1 / ask, aq * ask)
    return result


def scan(g: dict[str, dict[str, Edge]], start: str, amount: D,
         fee_bps: D, slippage_bps: D) -> list[dict]:
    factor = (1 - fee_bps / 10000) * (1 - slippage_bps / 10000)
    found = []
    for a, first in g.get(start, {}).items():
        for b, second in g.get(a, {}).items():
            if b == start or b == a:
                continue
            third = g.get(b, {}).get(start)
            if third is None:
                continue
            value = amount
            legs = (first, second, third)
            for leg in legs:
                if value > leg.capacity:
                    break
                value *= leg.rate * factor
            else:
                found.append({"route": [start, a, b, start],
                              "symbols": [e.symbol for e in legs],
                              "input": str(amount), "output": str(value),
                              "net_bps": str((value / amount - 1) * 10000)})
    return sorted(found, key=lambda r: D(r["net_bps"]), reverse=True)


def get_json(endpoint: str):
    # Fixed public GET allowlist. Secrets and execution are intentionally absent.
    if endpoint not in ("exchangeInfo", "ticker/bookTicker"):
        raise ValueError("Endpoint not allowed")
    with urlopen(BASE + endpoint, timeout=15) as response:
        return json.load(response)


def fixture():
    markets, quotes = [], []
    for symbol, base, quote, bid, ask in (
        ("BTCUSDT", "BTC", "USDT", "59990", "60000"),
        ("ETHBTC", "ETH", "BTC", ".04999", ".05"),
        ("ETHUSDT", "ETH", "USDT", "3060", "3061"),
    ):
        markets.append(dict(symbol=symbol, baseAsset=base, quoteAsset=quote,
                            status="TRADING", isSpotTradingAllowed=True))
        quotes.append(dict(symbol=symbol, bidPrice=bid, askPrice=ask,
                           bidQty="100", askQty="100"))
    return markets, quotes


def database(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, time REAL, mode TEXT, payload TEXT)")
    return db


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("demo", "live"), default="demo")
    parser.add_argument("--amount", type=D, default=D("68"))
    parser.add_argument("--asset", default="USDT")
    parser.add_argument("--fee-bps", type=D, default=D("10"))
    parser.add_argument("--slippage-bps", type=D, default=D("5"))
    parser.add_argument("--min-net-bps", type=D, default=D("10"))
    parser.add_argument("--interval", type=float, default=10)
    parser.add_argument("--max-fetch-seconds", type=float, default=3)
    parser.add_argument("--cycles", type=int, default=1, help="0 = run until Ctrl+C")
    parser.add_argument("--db", default="observations.sqlite")
    args = parser.parse_args()
    numbers = (args.amount, args.fee_bps, args.slippage_bps, args.min_net_bps)
    if (not all(n.is_finite() for n in numbers) or args.amount <= 0
            or not 0 <= args.fee_bps < 10000 or not 0 <= args.slippage_bps < 10000
            or args.min_net_bps < 0 or not 2 <= args.interval <= 60
            or not 0 < args.max_fetch_seconds <= 15 or args.cycles < 0):
        parser.error("Invalid amount, cost, interval, freshness or cycle settings")
    db = database(args.db)
    try:
        markets = fixture()[0] if args.mode == "demo" else get_json("exchangeInfo")["symbols"]
        cycle = 0
        while args.cycles == 0 or cycle < args.cycles:
            began = time.monotonic()
            quotes = fixture()[1] if args.mode == "demo" else get_json("ticker/bookTicker")
            fetch_seconds = time.monotonic() - began
            # REST books have no exchange timestamp: this bounds fetch latency only.
            rejected = fetch_seconds > args.max_fetch_seconds
            routes = [] if rejected else scan(graph(markets, quotes), args.asset,
                                               args.amount, args.fee_bps, args.slippage_bps)
            candidates = [r for r in routes if D(r["net_bps"]) >= args.min_net_bps]
            payload = {"mode": args.mode, "synthetic": args.mode == "demo",
                       "quotes": len(quotes), "routes_evaluated": len(routes),
                       "fetch_seconds": round(fetch_seconds, 3),
                       "rejected_slow_fetch": rejected,
                       "candidates": len(candidates), "best": routes[:5],
                       "fee_bps": str(args.fee_bps), "slippage_bps": str(args.slippage_bps),
                       "min_net_bps": str(args.min_net_bps),
                       "simulation": candidates[:1],
                       "warning": "Indicative snapshot only; no fills or realized profit. Independent simulations, no compounding."}
            encoded = json.dumps(payload, ensure_ascii=False)
            with db:
                db.execute("INSERT INTO observations(time,mode,payload) VALUES (?,?,?)",
                           (time.time(), args.mode, encoded))
            print(encoded, flush=True)
            cycle += 1
            if args.cycles == 0 or cycle < args.cycles:
                time.sleep(max(0, args.interval - (time.monotonic() - began)))
        return 0
    except HTTPError as exc:
        # Stop on rate limit/ban/errors rather than retry aggressively.
        print(json.dumps({"error": "public_api_http", "status": exc.code,
                          "retry_after": exc.headers.get("Retry-After"), "stopped": True}))
        return 1
    except (URLError, TimeoutError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"error": type(exc).__name__, "message": str(exc), "stopped": True}))
        return 1
    except KeyboardInterrupt:
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
