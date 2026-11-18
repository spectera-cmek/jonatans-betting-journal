import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { killTree, makeUtf8Decoder, parseRunArgs, runSummary } from "../lib/localJobs";
import { sendNtfy } from "../lib/ntfy";

describe("kör-filens argument", () => {
  it("tidsgräns före skriptnamnet, resten går vidare till skriptet", () => {
    expect(parseRunArgs(["--max-minutes", "170", "cs2:update", "--scrapling", "--headless"])).toEqual({
      maxMinutes: 170,
      script: "cs2:update",
      args: ["--scrapling", "--headless"],
    });
    expect(parseRunArgs(["shots:ingest", "--league", "all"])).toEqual({ maxMinutes: null, script: "shots:ingest", args: ["--league", "all"] });
  });
  it("en ogiltig tidsgräns ignoreras inte tyst", () => {
    expect(() => parseRunArgs(["--max-minutes", "x", "cs2:lines"])).toThrow(/max-minutes/);
  });
});

describe("tidsgräns i sammanfattningen", () => {
  it("en avbruten körning säger att tidsgränsen slog till", () => {
    expect(runSummary({ exitCode: null, seconds: 10200, lastLine: "→ /stats/x", notified: true, timedOutAfterMin: 170 })).toBe(
      "FEL (notis) · tidsgräns 170 min · 10200 s · → /stats/x"
    );
  });
});

describe("å/ä/ö delade mellan två bitar", () => {
  it("avkodas hela", () => {
    const bytes = Buffer.from("spärrats", "utf8");
    const cut = bytes.indexOf(0xc3) + 1; // mitt i "ä"
    const decode = makeUtf8Decoder();
    expect(decode(bytes.subarray(0, cut)) + decode(bytes.subarray(cut))).toBe("spärrats");
  });
});

describe("notisens felorsak", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("försöker en gång till och berättar varför det inte gick", async () => {
    vi.stubEnv("NTFY_TOPIC", "test");
    const fetchMock = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sendNtfy({ title: "t", message: "m" }, { retries: 1, retryDelayMs: 0 });
    expect(r).toEqual({ ok: false, error: "HTTP 429" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lyckas på andra försöket", async () => {
    vi.stubEnv("NTFY_TOPIC", "test");
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendNtfy({ title: "t", message: "m" }, { retries: 1, retryDelayMs: 0 })).toEqual({ ok: true });
  });

  it("utan NTFY_TOPIC görs inget anrop", async () => {
    vi.stubEnv("NTFY_TOPIC", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendNtfy({ title: "t", message: "m" })).toEqual({ ok: false, error: "NTFY_TOPIC saknas" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("processträdet", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("killTree stoppar både barnet och barnbarnet", async () => {
    // Barnet startar ett barnbarn och skriver ut dess pid — som cmd → npm → node.
    const child = spawn(
      process.execPath,
      ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    expect(alive(grandchild)).toBe(true);
    await killTree(child.pid!);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(child.pid!)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  }, 15000);
});

