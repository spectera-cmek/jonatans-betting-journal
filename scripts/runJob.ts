/**
 * Kör ett npm-skript åt Windows Schemaläggare (via scripts/run-job.cmd):
 *
 *   scripts\run-job.cmd cs2:update --scrapling --headless
 *   npx tsx scripts/runJob.ts shots:ingest --league all --confirm
 *   npx tsx scripts/runJob.ts --max-minutes 170 cs2:update --scrapling --headless
 *
 * - utdata läggs till i .claude/logs/<område>.log, med start- och slutrad
 * - skriptets riktiga exit-kod blir körningens, så Schemaläggaren visar fel som fel
 * - varje körning lämnar en SyncLog-rad "lokal:<skript>" i huvuddatabasen
 *   (sidornas "Uppdaterad"-indikator läser den)
 * - vid fel skickas en ntfy-notis, högst en per jobb och dygn (ett nytt försök;
 *   går den inte fram står orsaken i loggen)
 * - --max-minutes N stoppar jobbet med alla underprocesser när tiden gått ut.
 *   Schemaläggarens egen tidsgräns stoppar bara cmd.exe — node fortsatte.
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
import { jobArea, killTree, lastMeaningfulLine, makeUtf8Decoder, parseRunArgs, runSummary, shouldNotify, syncKind } from "../lib/localJobs";

const TAIL_LINES = 50;
/** Samma kod som GNU timeout använder för en avbruten körning. */
const TIMEOUT_EXIT = 124;

const stamp = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });

async function main() {
  let parsed: ReturnType<typeof parseRunArgs>;
  try {
    parsed = parseRunArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const { maxMinutes, script, args } = parsed;
  if (!script || !/^[a-z0-9-]+:[a-z0-9:-]+$/i.test(script)) {
    console.error("Användning: tsx scripts/runJob.ts [--max-minutes N] <npm-skript> [argument…]");
    process.exit(2);
  }
  const logDir = path.join(".claude", "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${jobArea(script)}.log`);
  const log = (line: string) => appendFileSync(logFile, line.endsWith("\n") ? line : line + "\n");

  log(`[${stamp()}] ${script} start`);
  const started = Date.now();
  const tail: string[] = [];
  const keep = (decode: (chunk: Buffer) => string) => (chunk: Buffer) => {
    const text = decode(chunk);
    appendFileSync(logFile, text);
    tail.push(...text.split(/\r?\n/));
    if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
  };

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const command = [npm, "run", script, ...(args.length ? ["--", ...args] : [])].join(" ");
  // Egen tidsgräns: Schemaläggarens stoppar bara cmd.exe, inte node-processerna under.
  let timedOut = false;
  let exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep(makeUtf8Decoder()));
    child.stderr.on("data", keep(makeUtf8Decoder()));
    const timer =
      maxMinutes != null && child.pid != null
        ? setTimeout(() => {
            timedOut = true;
            log(`
[${stamp()}] tidsgränsen ${maxMinutes} min nådd — stoppar ${script} med alla underprocesser`);
            void killTree(child.pid!);
          }, maxMinutes * 60_000)
        : null;
    child.on("error", (e) => {
      log(`kunde inte starta: ${e.message}`);
      resolve(null);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code);
    });
  });
  if (timedOut) exitCode = TIMEOUT_EXIT;
  const seconds = (Date.now() - started) / 1000;
  const lastLine = lastMeaningfulLine(tail.join("\n"));

  const notify = async () => {
    const r = await sendNtfy(
      { title: `${script} misslyckades`, message: timedOut ? `tidsgräns ${maxMinutes} min` : lastLine || `exit ${exitCode ?? "?"}`, tags: ["warning"] },
      { retries: 1, retryDelayMs: 5000 }
    );
    if (!r.ok) log(`notisen gick inte fram: ${r.error}`);
    return r.ok;
  };
  let notified = false;
  if (exitCode !== 0) {
    try {
      const prev = await prisma.syncLog.findFirst({
        where: { kind: syncKind(script), summary: { startsWith: "FEL (notis)" } },
        orderBy: { ranAt: "desc" },
        select: { ranAt: true },
      });
      if (shouldNotify(prev?.ranAt ?? null, new Date())) {
        notified = await notify();
      }
    } catch (e) {
      // Huvuddatabasen nere: hellre en notis för mycket än ingen.
      log(`kunde inte läsa SyncLog: ${(e as Error).message.split("\n").pop()}`);
      notified = await notify();
    }
  }

  const summary = runSummary({ exitCode, seconds, lastLine, notified, timedOutAfterMin: timedOut ? maxMinutes : null });
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
