"""Scrapling-hämtaren: en långlivad process som TS-skripten pratar med.

Körs bara lokalt (startas av lib/scrapling.ts), aldrig från Next/Vercel.
All tolkning, alla modeller och all databasskrivning stannar i TypeScript —
den här filen hämtar sidor och inget annat.

Protokoll: en JSON per rad. stdin tar anrop, stdout ger svar.

  anrop:  {"id": 1, "mode": "browser" | "http", "url": "...",
           "wait_selector"?: "...", "network_idle"?: true, "timeout_ms"?: 60000,
           "headers"?: {...}, "actions"?: [{"click_text": "..."} | {"click_first": ["...", "..."]}
                                           | {"wait_ms": 500} | {"wait_selector": "..."}]}
  svar:   {"id": 1, "ok": true, "status": 200, "url": "...", "body": "...",
           "actions"?: [{"ok": true} | {"ok": false, "detail": "..."}]}
          {"id": 1, "ok": false, "error": "..."}

Vid start skrivs {"ready": true}, eller {"ready": false, "error": "scrapling_missing"}
om paketet saknas. Webbläsaren och HTTP-sessionen öppnas först när de behövs
och lever kvar mellan anropen, så ett klarat Cloudflare-test gäller resten av
körningen (och nästa, via --profile).

Loggar går till stderr. stdout är reserverad för protokollet.
"""

import argparse
import json
import sys

# Protokollet får aldrig blandas med utskrifter från biblioteken.
PROTO = sys.stdout
sys.stdout = sys.stderr
for stream in (PROTO, sys.stdin, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def send(obj):
    # ensure_ascii: rena ASCII-rader överlever alla Windows-teckentabeller.
    PROTO.write(json.dumps(obj, ensure_ascii=True) + "\n")
    PROTO.flush()


def log(msg):
    print(f"[scrapling] {msg}", file=sys.stderr, flush=True)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--headed", action="store_true", help="synligt webbläsarfönster")
    p.add_argument("--profile", help="persistent webbläsarprofil (user_data_dir)")
    p.add_argument("--real-chrome", action="store_true", help="installerad Chrome i stället för Chromium")
    p.add_argument("--cdp-url", help="koppla upp mot en redan startad webbläsare")
    p.add_argument("--executable-path", help="egen Chromium-binär")
    p.add_argument("--no-cloudflare", action="store_true", help="försök inte lösa Cloudflare-kontroller")
    return p.parse_args()


def decode(body, encoding):
    if isinstance(body, str):
        return body
    try:
        return body.decode(encoding or "utf-8")
    except (LookupError, UnicodeDecodeError):
        return body.decode("utf-8", errors="replace")


class Worker:
    def __init__(self, args, fetchers):
        self.args = args
        self.fetchers = fetchers
        self.browser = None
        self.http = None
        self._http_cm = None

    def browser_session(self):
        if self.browser is None:
            opts = {
                "headless": not self.args.headed,
                "solve_cloudflare": not self.args.no_cloudflare,
                # Ingen Google-referer: HLTV och OddsPortal ska se en vanlig direktträff.
                "google_search": False,
            }
            if self.args.profile:
                opts["user_data_dir"] = self.args.profile
            if self.args.real_chrome:
                opts["real_chrome"] = True
            if self.args.cdp_url:
                opts["cdp_url"] = self.args.cdp_url
            if self.args.executable_path:
                opts["executable_path"] = self.args.executable_path
            log("startar webbläsaren (" + ("synlig" if self.args.headed else "osynlig") + ")")
            session = self.fetchers.StealthySession(**opts)
            session.__enter__()
            self.browser = session
        return self.browser

    def http_session(self):
        if self.http is None:
            cm = self.fetchers.FetcherSession(impersonate="chrome", retries=2)
            self.http = cm.__enter__()
            self._http_cm = cm
        return self.http

    def handle(self, req):
        mode = req.get("mode", "http")
        url = req["url"]
        timeout_ms = int(req.get("timeout_ms") or 60_000)
        if mode == "http":
            kwargs = {"timeout": timeout_ms / 1000}
            if req.get("headers"):
                kwargs["headers"] = req["headers"]
            res = self.http_session().get(url, **kwargs)
            return {
                "status": res.status,
                "url": str(res.url),
                "body": decode(res.body, getattr(res, "encoding", "utf-8")),
            }
        if mode == "browser":
            results = []
            kwargs = {"timeout": timeout_ms}
            if req.get("wait_selector"):
                kwargs["wait_selector"] = req["wait_selector"]
            if req.get("network_idle"):
                kwargs["network_idle"] = True
            if req.get("headers"):
                kwargs["extra_headers"] = req["headers"]
            actions = req.get("actions") or []
            if actions:
                kwargs["page_action"] = lambda page: run_actions(page, actions, results)
            res = self.browser_session().fetch(url, **kwargs)
            out = {
                "status": res.status,
                "url": str(res.url),
                "body": decode(res.body, getattr(res, "encoding", "utf-8")),
            }
            if actions:
                out["actions"] = results
            return out
        raise ValueError(f"okänt läge: {mode}")

    def close(self):
        if self.browser is not None:
            try:
                self.browser.__exit__(None, None, None)
            except Exception as e:  # noqa: BLE001 — stängningen får aldrig krascha
                log(f"kunde inte stänga webbläsaren: {e}")
            self.browser = None
        if self._http_cm is not None:
            try:
                self._http_cm.__exit__(None, None, None)
            except Exception as e:  # noqa: BLE001
                log(f"kunde inte stänga HTTP-sessionen: {e}")
            self._http_cm = None
            self.http = None


def run_actions(page, actions, results):
    """Utför klick och väntan som TS bett om. Ett misslyckat steg stoppar inte resten."""
    for action in actions:
        try:
            if "click_text" in action:
                exact = action.get("exact", True)
                page.get_by_text(action["click_text"], exact=exact).first.click(timeout=action.get("timeout_ms", 8000))
            elif "click_first" in action:
                # Första texten som finns och syns klickas; resten provas inte.
                exact = action.get("exact", True)
                for text in action["click_first"]:
                    loc = page.get_by_text(text, exact=exact).first
                    if loc.count() and loc.is_visible():
                        loc.click(timeout=action.get("timeout_ms", 8000))
                        break
                else:
                    raise ValueError(f"ingen av {action['click_first']} finns på sidan")
            elif "wait_ms" in action:
                page.wait_for_timeout(int(action["wait_ms"]))
            elif "wait_selector" in action:
                page.locator(action["wait_selector"]).first.wait_for(timeout=action.get("timeout_ms", 12000))
            else:
                raise ValueError(f"okänt steg: {action}")
            results.append({"ok": True})
        except Exception as e:  # noqa: BLE001 — rapporteras tillbaka till TS
            results.append({"ok": False, "detail": str(e).splitlines()[0][:300]})


def main():
    args = parse_args()
    try:
        from scrapling import fetchers
    except ImportError as e:
        send({"ready": False, "error": "scrapling_missing", "detail": str(e)})
        return 2

    worker = Worker(args, fetchers)
    send({"ready": True})
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as e:
                send({"id": None, "ok": False, "error": f"ogiltig JSON: {e}"})
                continue
            if req.get("op") == "close":
                break
            rid = req.get("id")
            try:
                send({"id": rid, "ok": True, **worker.handle(req)})
            except Exception as e:  # noqa: BLE001 — varje fel blir ett svar, inte en krasch
                send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})
    finally:
        worker.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
