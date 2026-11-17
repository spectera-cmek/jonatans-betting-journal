/**
 * Installerar Scrapling i projektets egen Python-miljö (.venv) och laddar ner
 * webbläsaren den styr. Körs en gång (och efter en versionshöjning i
 * scrapers/requirements.txt).
 *
 *   npm run scrapling:setup
 *   npm run scrapling:setup -- --python "C:\Python312\python.exe"
 *
 * Kräver Python 3.10+. Utan --python används `py -3` på Windows (följer med
 * python.org-installationen), annars python3.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { WORKER_SCRIPT } from "../../lib/scrapling";

const isWin = process.platform === "win32";
const VENV = ".venv";
const venvPython = isWin ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function run(cmd: string, args: string[], label: string): void {
  console.log(`\n▶ ${label}\n  ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error || res.status !== 0) {
    console.error(`\n✗ ${label} misslyckades${res.error ? `: ${res.error.message}` : ` (kod ${res.status})`}`);
    process.exit(1);
  }
}

/** Basprogrammet som skapar .venv: [kommando, ...förargument]. */
function basePython(): [string, string[]] {
  const explicit = argValue("--python");
  if (explicit) return [explicit, []];
  const candidates: [string, string[]][] = isWin ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
  for (const [cmd, pre] of candidates) {
    const res = spawnSync(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
    if (res.status === 0) return [cmd, pre];
  }
  console.error("✗ Hittar ingen Python. Installera Python 3.10+ (winget install Python.Python.3.12) eller ange --python <sökväg>.");
  process.exit(1);
}

function main() {
  if (!existsSync(WORKER_SCRIPT)) {
    console.error(`✗ Kör från projektroten (hittar inte ${WORKER_SCRIPT}).`);
    process.exit(1);
  }

  if (!existsSync(venvPython)) {
    const [cmd, pre] = basePython();
    const ver = spawnSync(cmd, [...pre, "-c", "import sys; print(sys.version_info >= (3, 10))"], { encoding: "utf8" });
    if (ver.stdout.trim() !== "True") {
      console.error(`✗ Scrapling kräver Python 3.10 eller senare ("${cmd}" är äldre).`);
      process.exit(1);
    }
    run(cmd, [...pre, "-m", "venv", VENV], "Skapar .venv");
  } else {
    console.log(`.venv finns redan (${venvPython})`);
  }

  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], "Uppdaterar pip");
  run(venvPython, ["-m", "pip", "install", "-r", path.join("scrapers", "requirements.txt")], "Installerar Scrapling");
  // Samma som kommandot `scrapling install`: Playwrights Chromium (+ systemberoenden på Linux).
  run(venvPython, ["-c", "import sys; from scrapling.cli import main; sys.exit(main())", "install"], "Laddar ner webbläsaren");

  console.log("\n✓ Klart. Prova kedjan med: npm run scrapling:check");
}

main();
