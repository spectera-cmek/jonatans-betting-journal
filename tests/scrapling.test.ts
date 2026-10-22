import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScraplingError, ScraplingWorker, resolvePython } from "../lib/scrapling";

const FAKE = path.join(__dirname, "fixtures", "scrapling", "fakeWorker.mjs");

let worker: ScraplingWorker | null = null;
function fake(extra: string[] = [], opts: ConstructorParameters<typeof ScraplingWorker>[0] = {}) {
  worker = new ScraplingWorker({ command: process.execPath, args: [FAKE, ...extra], ...opts });
  return worker;
}

afterEach(async () => {
  await worker?.close();
  worker = null;
});

describe("resolvePython", () => {
  it("SCRAPLING_PYTHON vinner", () => {
    expect(resolvePython({ SCRAPLING_PYTHON: "C:/py/python.exe" }, "/repo", "win32", () => true)).toBe("C:/py/python.exe");
  });
  it("projektets .venv före PATH", () => {
    expect(resolvePython({}, "/repo", "linux", () => true)).toBe(path.join("/repo", ".venv", "bin", "python"));
    expect(resolvePython({}, "C:/repo", "win32", () => true)).toBe(path.join("C:/repo", ".venv", "Scripts", "python.exe"));
  });
  it("annars python/python3", () => {
    expect(resolvePython({}, "/repo", "win32", () => false)).toBe("python");
    expect(resolvePython({}, "/repo", "linux", () => false)).toBe("python3");
  });
});

describe("ScraplingWorker", () => {
  it("skickar anropet i workerns format och tar emot svaret", async () => {
    const w = fake([], { headed: true, profileDir: ".cache/x", cdpUrl: "http://localhost:9222" });
    const res = await w.fetch({
      mode: "browser",
      url: "fake://ok",
      waitSelector: ".odds",
      actions: [{ clickText: "Over/Under" }, { waitMs: 300 }, { waitSelector: ".row" }],
      timeoutMs: 30_000,
    });
    expect(res.status).toBe(200);
    const { req, argv } = JSON.parse(res.body);
    expect(req).toMatchObject({
      mode: "browser",
      url: "fake://ok",
      wait_selector: ".odds",
      timeout_ms: 25_000,
      actions: [{ click_text: "Over/Under", exact: true }, { wait_ms: 300 }, { wait_selector: ".row" }],
    });
    expect(argv).toEqual(["--headed", "--profile", ".cache/x", "--cdp-url", "http://localhost:9222"]);
  });

  it("flera anrop i följd återanvänder samma process", async () => {
    const w = fake();
    const a = await w.fetch({ mode: "http", url: "fake://ok" });
    const b = await w.fetch({ mode: "http", url: "fake://ok" });
    expect(JSON.parse(a.body).req.id).toBe(1);
    expect(JSON.parse(b.body).req.id).toBe(2);
  });

  it("fetchJson tolkar JSON och kastar på icke-2xx", async () => {
    const w = fake();
    await expect(w.fetchJson<{ a: number }>("fake://json")).resolves.toEqual({ a: 1 });
    await expect(w.fetchJson("fake://404")).rejects.toThrow(/HTTP 404/);
  });

  it("workerns fel blir ScraplingError", async () => {
    const w = fake();
    await expect(w.fetch({ mode: "http", url: "fake://error" })).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("ett anrop som fastnar ger timeout, och nästa anrop startar om workern", async () => {
    const w = fake();
    await expect(w.fetch({ mode: "http", url: "fake://slow", timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
    const res = await w.fetch({ mode: "http", url: "fake://json" });
    expect(res.body).toBe('{"a":1}');
  });

  it("en kraschad worker ger worker_died och startas om", async () => {
    const w = fake();
    await expect(w.fetch({ mode: "http", url: "fake://crash" })).rejects.toMatchObject({ code: "worker_died" });
    await expect(w.fetchJson("fake://json")).resolves.toEqual({ a: 1 });
  });

  it("saknat paket ger ett tydligt fel", async () => {
    const w = fake(["--missing"]);
    const err = await w.fetch({ mode: "http", url: "fake://ok" }).catch((e) => e);
    expect(err).toBeInstanceOf(ScraplingError);
    expect(err.code).toBe("scrapling_missing");
    expect(err.message).toMatch(/scrapling:setup/);
  });

  it("saknad Python ger ett tydligt fel", async () => {
    worker = new ScraplingWorker({ command: "finns-inte-python-xyz" });
    await expect(worker.fetch({ mode: "http", url: "fake://ok" })).rejects.toMatchObject({ code: "python_missing" });
  });
});
