// Klient mot Scrapling-hämtaren (scrapers/worker.py). Körs bara lokalt, från
// skripten — aldrig från Next/Vercel, där finns varken Python eller webbläsare.
//
// Python hämtar, TypeScript tolkar: workern ger tillbaka rå HTML eller JSON och
// allt annat (parsers, modeller, databas) ligger kvar här på TS-sidan.
//
// En process per körning. Den startas vid första anropet och lever kvar, så
// webbläsaren och ett klarat Cloudflare-test återanvänds. Dör den (eller
// fastnar ett anrop) startas en ny vid nästa anrop.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export type ScraplingAction =
  | { clickText: string; exact?: boolean; timeoutMs?: number }
  | { waitMs: number }
  | { waitSelector: string; timeoutMs?: number };

export interface ScraplingRequest {
  /** "http": snabb hämtning med webbläsarens TLS-fingeravtryck. "browser": riktig webbläsare. */
  mode: "http" | "browser";
  url: string;
  /** Bara browser: vänta tills selektorn finns innan sidan lämnas tillbaka. */
  waitSelector?: string;
  /** Bara browser: vänta tills nätverket är tyst. */
  networkIdle?: boolean;
  /** Bara browser: klick och väntan som körs efter att sidan laddats. */
  actions?: ScraplingAction[];
  headers?: Record<string, string>;
  /** Hela anropets tak. Standard 60 s (http) / 180 s (browser, Cloudflare kan ta tid). */
  timeoutMs?: number;
}

export interface ScraplingResponse {
  status: number;
  url: string;
  body: string;
  /** Ett resultat per steg i `actions`, i samma ordning. */
  actions?: { ok: boolean; detail?: string }[];
}

export interface ScraplingWorkerOptions {
  /** Synligt webbläsarfönster. Standard: osynligt. */
  headed?: boolean;
  /** Persistent webbläsarprofil — sparar cookies (och Cloudflare-godkännandet) mellan körningar. */
  profileDir?: string;
  /** Installerad Chrome i stället för Playwrights Chromium. */
  realChrome?: boolean;
  /** Koppla upp mot en redan startad webbläsare (t.ex. CS2_CDP_URL). */
  cdpUrl?: string;
  /** Egen Chromium-binär (SCRAPLING_BROWSER_PATH). */
  executablePath?: string;
  /** Försök inte lösa Cloudflare-kontroller (sparar några sekunder per sida). */
  noCloudflare?: boolean;
  /** Programmet som kör workern. Standard: se resolvePython(). */
  command?: string;
  /** Argument före workerns egna. Standard: [scrapers/worker.py]. */
  args?: string[];
  /** Hur länge workern får ta på sig att starta. */
  startTimeoutMs?: number;
  /** Workerns stderr, rad för rad. Standard: tyst. */
  onLog?: (line: string) => void;
}

export class ScraplingError extends Error {
  constructor(
    message: string,
    readonly code: "python_missing" | "scrapling_missing" | "start_failed" | "timeout" | "worker_died" | "fetch_failed"
  ) {
    super(message);
    this.name = "ScraplingError";
  }
}

const SETUP_HINT = "Kör: npm run scrapling:setup";

/**
 * Vilken Python som kör workern: SCRAPLING_PYTHON om satt, annars projektets
 * .venv (som scrapling:setup skapar), annars python/python3 i PATH.
 */
export function resolvePython(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): string {
  if (env.SCRAPLING_PYTHON) return env.SCRAPLING_PYTHON;
  const venv =
    platform === "win32" ? path.join(cwd, ".venv", "Scripts", "python.exe") : path.join(cwd, ".venv", "bin", "python");
  if (exists(venv)) return venv;
  return platform === "win32" ? "python" : "python3";
}

export const WORKER_SCRIPT = path.join("scrapers", "worker.py");

type Pending = {
  resolve: (r: ScraplingResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class ScraplingWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail: string[] = [];

  constructor(private readonly opts: ScraplingWorkerOptions = {}) {}

  private workerArgs(): string[] {
    const o = this.opts;
    const out = [...(o.args ?? [WORKER_SCRIPT])];
    if (o.headed) out.push("--headed");
    if (o.profileDir) out.push("--profile", o.profileDir);
    if (o.realChrome) out.push("--real-chrome");
    if (o.cdpUrl) out.push("--cdp-url", o.cdpUrl);
    const exe = o.executablePath ?? process.env.SCRAPLING_BROWSER_PATH;
    if (exe) out.push("--executable-path", exe);
    if (o.noCloudflare) out.push("--no-cloudflare");
    return out;
  }

  private start(): Promise<void> {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    const command = this.opts.command ?? resolvePython();
    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: ScraplingError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.kill();
        this.proc = null;
        reject(err);
      };
      const proc = spawn(command, this.workerArgs(), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
        windowsHide: true,
      });
      const timer = setTimeout(
        () => fail(new ScraplingError(`Scrapling-workern startade inte inom ${(this.opts.startTimeoutMs ?? 60_000) / 1000} s. ${this.tail()}`, "start_failed")),
        this.opts.startTimeoutMs ?? 60_000
      );

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          fail(new ScraplingError(`Hittar inte Python ("${command}"). Installera Python 3.10+ eller sätt SCRAPLING_PYTHON. ${SETUP_HINT}`, "python_missing"));
        } else {
          fail(new ScraplingError(`Kunde inte starta Scrapling-workern: ${err.message}`, "start_failed"));
        }
      });

      createInterface({ input: proc.stderr }).on("line", (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.opts.onLog?.(line);
      });

      createInterface({ input: proc.stdout }).on("line", (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // inte protokoll — ska inte hända, men får aldrig krascha
        }
        if ("ready" in msg) {
          if (msg.ready === true) {
            settled = true;
            clearTimeout(timer);
            resolve();
          } else if (msg.error === "scrapling_missing") {
            fail(new ScraplingError(`Python hittades men inte paketet scrapling. ${SETUP_HINT}`, "scrapling_missing"));
          } else {
            fail(new ScraplingError(`Scrapling-workern kunde inte starta: ${String(msg.detail ?? msg.error)}`, "start_failed"));
          }
          return;
        }
        this.settle(msg);
      });

      proc.on("exit", (code) => {
        if (!settled) {
          fail(new ScraplingError(`Scrapling-workern avslutades direkt (kod ${code}). ${this.tail()}`, "start_failed"));
          return;
        }
        // En process vi redan släppt (timeout, close) får inte röra nästa process anrop.
        if (this.proc !== proc) return;
        this.proc = null;
        this.rejectAll(new ScraplingError(`Scrapling-workern avslutades (kod ${code}). ${this.tail()}`, "worker_died"));
      });

      this.proc = proc;
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private tail(): string {
    return this.stderrTail.length ? `Senaste logg: ${this.stderrTail.slice(-3).join(" | ")}` : "";
  }

  private settle(msg: Record<string, unknown>): void {
    const id = typeof msg.id === "number" ? msg.id : null;
    const p = id == null ? undefined : this.pending.get(id);
    if (!p || id == null) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok === true) {
      p.resolve({
        status: Number(msg.status ?? 0),
        url: String(msg.url ?? ""),
        body: String(msg.body ?? ""),
        actions: msg.actions as ScraplingResponse["actions"],
      });
    } else {
      p.reject(new ScraplingError(String(msg.error ?? "okänt fel"), "fetch_failed"));
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Hämtar en sida. Kastar ScraplingError vid fel — en 404 eller 403 är inget fel, se `status`. */
  async fetch(req: ScraplingRequest): Promise<ScraplingResponse> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new ScraplingError("Scrapling-workern är inte igång", "worker_died");
    const id = this.nextId++;
    const timeoutMs = req.timeoutMs ?? (req.mode === "browser" ? 180_000 : 60_000);
    const wire = {
      id,
      mode: req.mode,
      url: req.url,
      wait_selector: req.waitSelector,
      network_idle: req.networkIdle,
      // Workern får lite kortare tid än vi väntar, så den hinner svara med sitt eget fel.
      timeout_ms: Math.max(5_000, timeoutMs - 5_000),
      headers: req.headers,
      actions: req.actions?.map((a) =>
        "clickText" in a
          ? { click_text: a.clickText, exact: a.exact ?? true, timeout_ms: a.timeoutMs }
          : "waitMs" in a
            ? { wait_ms: a.waitMs }
            : { wait_selector: a.waitSelector, timeout_ms: a.timeoutMs }
      ),
    };
    return new Promise<ScraplingResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Ett anrop som fastnat lämnar workern i okänt läge — släpp den och
        // börja om vid nästa anrop.
        if (this.proc === proc) {
          this.proc = null;
          this.rejectAll(new ScraplingError("Scrapling-workern startades om efter en timeout", "worker_died"));
        }
        proc.kill();
        reject(new ScraplingError(`Scrapling svarade inte inom ${timeoutMs / 1000} s: ${req.url}`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify(wire) + "\n");
    });
  }

  /** HTTP-hämtning som tolkas som JSON. Kastar om svaret inte är 2xx eller inte är JSON. */
  async fetchJson<T>(url: string, opts: Omit<ScraplingRequest, "mode" | "url"> = {}): Promise<T> {
    const res = await this.fetch({ ...opts, mode: "http", url });
    if (res.status < 200 || res.status >= 300) {
      throw new ScraplingError(`HTTP ${res.status} från ${url}`, "fetch_failed");
    }
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new ScraplingError(`Svaret från ${url} var inte JSON (${res.body.slice(0, 80)}…)`, "fetch_failed");
    }
  }

  /** Stänger webbläsaren och processen. Säker att anropa flera gånger. */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 10_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.stdin.write(JSON.stringify({ op: "close" }) + "\n");
      proc.stdin.end();
    });
    this.rejectAll(new ScraplingError("Scrapling-workern stängdes", "worker_died"));
  }
}
