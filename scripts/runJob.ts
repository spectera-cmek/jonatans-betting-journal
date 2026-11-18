/**
 * Kör ett npm-skript åt Windows Schemaläggare (via scripts/run-job.cmd):
 *
 *   scripts\run-job.cmd cs2:update --scrapling --headless
 *   npx tsx scripts/runJob.ts shots:ingest --league all --confirm
 *
 * - utdata läggs till i .claude/logs/<område>.log, med start- och slutrad
 * - skriptets riktiga exit-kod blir körningens, så Schemaläggaren visar fel som fel
 * - varje körning lämnar en SyncLog-rad "lokal:<skript>" i huvuddatabasen
 *   (sidornas "Uppdaterad"-indikator läser den)
 * - vid fel skickas en ntfy-notis, högst en per jobb och dygn
 *
 * Databas och notis är bästa försök: går huvuddatabasen inte att nå loggas det
 * i filen och exit-koden blir ändå skriptets.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { prisma } from "../lib/db";
import { sendNtfy } from "../lib/ntfy";
import { jobArea, lastMeaningfulLine, runSummary, shouldNotify, syncKind } from "../lib/localJobs";

const TAIL_LINES = 50;

const stamp = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });

async function main() {
  const [script, ...args] = process.argv.slice(2);
  if (!script || !/^[a-z0-9-]+:[a-z0-9:-]+$/i.test(script)) {
    console.error("Användning: tsx scripts/runJob.ts <npm-skript> [argument…]");
    process.exit(2);
  }
  const logDir = path.join(".claude", "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${jobArea(script)}.log`);
  const log = (line: string) => appendFileSync(logFile, line.endsWith("\n") ? line : line + "\n");

  log(`[${stamp()}] ${script} start`);
  const started = Date.now();
  const tail: string[] = [];
  const keep = (chunk: Buffer) => {
    const text = chunk.toString();
    appendFileSync(logFile, text);
    tail.push(...text.split(/\r?\n/));
    if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
  };

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const command = [npm, "run", script, ...(args.length ? ["--", ...args] : [])].join(" ");
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => {
      log(`kunde inte starta: ${e.message}`);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  const seconds = (Date.now() - started) / 1000;
  const lastLine = lastMeaningfulLine(tail.join("\n"));

  let notified = false;
  if (exitCode !== 0) {
    try {
      const prev = await prisma.syncLog.findFirst({
        where: { kind: syncKind(script), summary: { startsWith: "FEL (notis)" } },
        orderBy: { ranAt: "desc" },
        select: { ranAt: true },
      });
      if (shouldNotify(prev?.ranAt ?? null, new Date())) {
        notified = await sendNtfy({ title: `${script} misslyckades`, message: lastLine || `exit ${exitCode ?? "?"}`, tags: ["warning"] });
      }
    } catch (e) {
      // Huvuddatabasen nere: hellre en notis för mycket än ingen.
      log(`kunde inte läsa SyncLog: ${(e as Error).message.split("\n").pop()}`);
      notified = await sendNtfy({ title: `${script} misslyckades`, message: lastLine || `exit ${exitCode ?? "?"}`, tags: ["warning"] });
    }
  }

  const summary = runSummary({ exitCode, seconds, lastLine, notified });
  try {
    await prisma.syncLog.create({ data: { kind: syncKind(script), summary } });
  } catch (e) {
    log(`kunde inte skriva SyncLog: ${(e as Error).message.split("\n").pop()}`);
  }
  log(`[${stamp()}] ${script} done exit=${exitCode ?? "?"} · ${summary}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(exitCode ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
