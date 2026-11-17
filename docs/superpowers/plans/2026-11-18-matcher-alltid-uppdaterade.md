# Matcher alltid uppdaterade – byggplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Mål:** Skott och CS2 uppdateras av sig själva via Windows Schemaläggare, NBA går igång igen den 1 december med en lokal historikcache, och varje sida visar hur färsk datan är.

**Arkitektur:** Alla jobb körs via `scripts/run-job.cmd`, som anropar `scripts/runJob.ts`. Den registrerar exit-koden, skriver en `SyncLog`-rad (`lokal:<jobb>`) i huvuddatabasen och skickar en ntfy-notis vid fel. Ett installationsskript lägger in samtliga uppgifter. Sidorna läser `SyncLog` via `/api/freshness`.

**Teknik:** Next.js App Router, Prisma (huvud-DB och NBA-DB), Vitest, PowerShell ScheduledTasks och tsx.

**Spec:** `docs/superpowers/specs/2026-11-17-matcher-alltid-uppdaterade-design.md`

## Globala begränsningar

- `SyncLog.kind` för lokala körningar har formen `lokal:<npm-skript>`, till exempel `lokal:cs2:update`.
- `summary` är högst 500 tecken. En lyckad körning börjar med `ok`. Ett fel börjar med `FEL`, och ett fel som skickade notis börjar med `FEL (notis)`.
- Högst en notis per jobb och 24 timmar.
- Indikatorn blir gul (`warn`) när det gått mer än 30 timmar sedan senaste lyckade körning. Den blir röd (`neg`) när senaste körningen misslyckades.
- NBA-cachen används bara när `process.env.VERCEL` saknas. Den ligger i `.cache/nba/`.
- Skriptloggarna skrivs till `.claude/logs/<område>.log`, där området är det som står före första `:` (`nba`, `cs2`, `shots`).
- Uppgiftsnamnen börjar med `BettingTracker-`. De fem befintliga NBA-namnen behålls.
- UI-texten är på svenska och visar siffror, inte prosa.

## Granskningsfokus

1. **NBA-databasen är nere och svarar med 402.** `runJob` ska ändå skriva `SyncLog` (huvud-DB) och notifiera. Det är bara NBA-skriptet som fallerar. Test i Task 1.
2. **Huvuddatabasen går inte att nå.** `runJob` ska ändå returnera skriptets exit-kod och skriva till loggfilen. Det får inte krascha. Test i Task 1.
3. **Cachefilen är trasig eller har fel version.** Då ska cachen byggas om från databasen. Det får inte krascha. Test i Task 3.
4. **En match vars box eller stintar sparats om** (ändrat `updatedAt`) ska ersätta sina rader i cachen och inte ge dubbletter. Test i Task 3.
5. **Ett jobb som aldrig körts** (inga `SyncLog`-rader) ska visas som "aldrig" i gult. Det får inte bli tomt eller krascha. Test i Task 4.

---

### Task 1: Kör-fil med exit-kod, SyncLog och notis

**Filer:**
- Skapa: `lib/ntfy.ts`, `lib/localJobs.ts`, `scripts/runJob.ts`, `scripts/run-job.cmd`, `tests/localJobs.test.ts`
- Ändra: `scripts/nba/liveWatch.ts` (ersätt den lokala `notify` med `sendNtfy`)

**Gränssnitt:**
- Producerar `lib/ntfy.ts`: `sendNtfy(n: { title: string; message: string; priority?: number; tags?: string[]; click?: string }): Promise<boolean>`. Returnerar `false` utan anrop om `NTFY_TOPIC` saknas. Läser `NTFY_URL`, med standardvärdet `https://ntfy.sh`.
- Producerar `lib/localJobs.ts`, som är rena funktioner och kan importeras av både skript och app:
  - `jobArea(script: string): string`. Till exempel ger `"cs2:update"` resultatet `"cs2"`.
  - `syncKind(script: string): string`. Ger `` `lokal:${script}` ``.
  - `runSummary(r: { exitCode: number | null; seconds: number; lastLine: string; notified: boolean }): string`
  - `shouldNotify(lastNotifiedAt: Date | null, now: Date): boolean`
  - `lastMeaningfulLine(output: string): string`. Returnerar sista raden som inte är tom och inte är npm-brus (rader som börjar med `>`).
- `scripts/runJob.ts`: `tsx scripts/runJob.ts <npm-skript> [args…]`

- [ ] **Steg 1: Skriv testerna i `tests/localJobs.test.ts`**

```ts
expect(jobArea("cs2:update")).toBe("cs2");
expect(jobArea("shots:ingest")).toBe("shots");
expect(syncKind("nba:update")).toBe("lokal:nba:update");
expect(runSummary({ exitCode: 0, seconds: 42, lastLine: "x", notified: false })).toBe("ok · 42 s");
expect(runSummary({ exitCode: 1, seconds: 3, lastLine: "Can't reach database server", notified: true }))
  .toBe("FEL (notis) · exit 1 · 3 s · Can't reach database server");
expect(runSummary({ exitCode: null, seconds: 3, lastLine: "", notified: false })).toBe("FEL · exit ? · 3 s");
expect(runSummary({ exitCode: 1, seconds: 1, lastLine: "y".repeat(900), notified: false }).length).toBe(500);
const now = new Date("2026-11-18T12:00:00Z");
expect(shouldNotify(null, now)).toBe(true);
expect(shouldNotify(new Date("2026-11-18T01:00:00Z"), now)).toBe(false);
expect(shouldNotify(new Date("2026-11-17T11:59:00Z"), now)).toBe(true);
expect(lastMeaningfulLine("a\n> tsx x\nfel här\n\n")).toBe("fel här");
```

- [ ] **Steg 2:** `npx vitest run tests/localJobs.test.ts`. Förväntat: FAIL, eftersom modulen saknas.
- [ ] **Steg 3: Implementera `lib/localJobs.ts` och `lib/ntfy.ts`.** Flytta fetch-anropet från `notify` i `liveWatch.ts` till `sendNtfy`, och låt `liveWatch` anropa den. Behåll taggen `basketball` där.
- [ ] **Steg 4:** `npx vitest run tests/localJobs.test.ts`. Förväntat: PASS.
- [ ] **Steg 5: Implementera `scripts/runJob.ts`.**
  1. Kör `npm.cmd run <skript> -- <args>` med `spawn` och `shell: true`.
  2. Skicka stdout och stderr både till `.claude/logs/<område>.log` (lägg till i slutet, med start- och slutrad i samma format som `run-nba.cmd`) och till en ringbuffert på de senaste 50 raderna.
  3. Vid fel: hämta senaste `SyncLog` med samma `kind` och `summary` som börjar med `FEL (notis)`. Om `shouldNotify` säger ja, anropa `sendNtfy` med titeln `` `${skript} misslyckades` `` och felraden som text.
  4. Skriv `SyncLog` med `prisma` från `lib/db`.
  5. Alla databas- och notisanrop ligger i try/catch och loggas till filen. Avsluta med `process.exit(exitCode ?? 1)`.
- [ ] **Steg 6: Skapa `scripts/run-job.cmd`.**

```bat
@echo off
setlocal
cd /d "%~dp0\.."
call npx.cmd tsx scripts/runJob.ts %*
exit /b %ERRORLEVEL%
```

- [ ] **Steg 7: Verifiera.**
  - `scripts\run-job.cmd shots:backtest --help` ger rätt exit-kod (`echo %ERRORLEVEL%`), en rad i `.claude/logs/shots.log` och en `lokal:shots:backtest`-rad i `SyncLog`.
  - `scripts\run-job.cmd nba:update` ger exit-kod skild från 0 (NBA-DB:n svarar 402), en `FEL (notis)`-rad och en notis.
  - En andra körning direkt efter ger en `FEL`-rad men ingen ny notis.
- [ ] **Steg 8: Committa.**

### Task 2: Installationsskript, paus och återstart av NBA

**Filer:**
- Skapa: `scripts/install-tasks.ps1`
- Ta bort: `scripts/install-nba-tasks.ps1`, `scripts/run-nba.cmd`
- Ändra: `package.json` (`install:nba-tasks` ersätts av `"install:tasks": "powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1"`)

**Gränssnitt:**
- Använder `scripts/run-job.cmd <npm-skript> [args…]` från Task 1.
- Parametrar: samma som `install-nba-tasks.ps1`, plus `-ShotsAt "09:00"`, `-Cs2At "10:00"`, `-Cs2LinesFrom "12:00"`, `-Cs2LinesHours 10` och `-NbaResumeAt ""`.

| Namn | Argument till run-job.cmd | Trigger | StartWhenAvailable |
|---|---|---|---|
| BettingTracker-Shots | `shots:ingest --league all --confirm` | dagligen 09:00 | ja |
| BettingTracker-Cs2Update | `cs2:update --scrapling --headless` | dagligen 10:00 | ja |
| BettingTracker-Cs2Lines | `cs2:lines` | 12:00, var 120:e min i 10 h | nej |
| BettingTracker-Nba{Update,Closing,Lineups,Smarkets,Live} | `nba:update`, `nba:closing`, `nba:lineups`, `nba:smarkets`, `nba:live-watch` | som i dag | som i dag |

Tidsgränser: Shots och Cs2Update får 3 h, eftersom första körningen hämtar mycket. Live behåller sina 19 h. Övriga får 30 min.

- [ ] **Steg 1: Skriv `install-tasks.ps1`.** Behåll strukturen från `install-nba-tasks.ps1`: tabellen ovan, samma principal och samma settings-logik. Det enda nya är att `-Argument` blir `"<skript> <args>"` till `run-job.cmd`.
- [ ] **Steg 2: Lägg till paus och återstart.** När `-NbaResumeAt` är satt:
  1. Kör `Disable-ScheduledTask` på de fem NBA-uppgifterna.
  2. Registrera engångsuppgiften `BettingTracker-NbaResume` vid den tidpunkten. Den kör `powershell -Command "Get-ScheduledTask BettingTracker-Nba* | Where-Object TaskName -ne 'BettingTracker-NbaResume' | Enable-ScheduledTask; Unregister-ScheduledTask BettingTracker-NbaResume -Confirm:$false"`.
- [ ] **Steg 3: Ta bort de gamla filerna och uppdatera `package.json`.** Kontrollera att inget annat refererar dem: `rg "run-nba|install-nba-tasks"` ska bara ge träffar i docs.
- [ ] **Steg 4: Verifiera** med `npm run install:tasks -- -NbaResumeAt "2026-12-01 06:00"` och sedan `Get-ScheduledTask BettingTracker-* | Select TaskName,State`. Förväntat: Shots, Cs2Update och Cs2Lines är Ready, de fem NBA-uppgifterna är Disabled och NbaResume är Ready. `Start-ScheduledTask BettingTracker-Cs2Lines` ger en `lokal:cs2:lines`-rad.
- [ ] **Steg 5: Committa.**

### Task 3: Lokal cache för NBA-historiken

**Filer:**
- Skapa: `lib/nba/historyCache.ts`, `tests/nbaHistoryCache.test.ts`
- Ändra: `lib/nba/store.ts`, alltså `loadHistory` (rad ~238) och `loadStints` (rad ~167)

**Gränssnitt:**
- Producerar, som rena funktioner:
  - `CACHE_VERSION = 1`
  - `interface CachedGame { id: number; version: string; startAt: string; periods: number | null; homeTeamId: number; awayTeamId: number; team: TeamRaw[]; players: PlayerRaw[]; stints: StintRaw[] }`. `version` är `updatedAt.toISOString()`. `TeamRaw` är en `nbaTeamGame`-rad. `PlayerRaw` är de fält `loadHistory` redan väljer. `StintRaw` är de fält `loadStints` väljer, utan `id`.
  - `planRefresh(cached: Map<number, string>, current: { id: number; version: string }[]): { fetch: number[]; drop: number[] }`. `fetch` innehåller matcher som är nya eller har ändrad version. `drop` innehåller matcher som finns i cachen men inte i `current`.
  - `readCache(file: string): Map<number, CachedGame>`. Saknad fil, trasig JSON eller annan `CACHE_VERSION` ger en tom Map.
  - `writeCache(file: string, games: Map<number, CachedGame>): void`. Skriver först till en tmp-fil och byter sedan namn, så att en avbruten skrivning inte förstör cachen.
  - `historyCacheFile(): string | null`. Ger `.cache/nba/history.json`, eller `null` när `VERCEL` är satt.
  - `syncCache(db: NbaPrisma, since: Date, opts: { withStints: boolean; log?: (m: string) => void }): Promise<CachedGame[]>`
    1. Läs `id` och `updatedAt` för färdiga matcher med box sedan `since`.
    2. Kör `planRefresh` mot cachen.
    3. Hämta box- och stintrader bara för `fetch`, i bitar om 200 matcher och med `withDbRetry`.
    4. Ta bort `drop`, skriv cachen och logga `` `historik: ${n} matcher ur cachen, ${f} hämtade` ``.
    5. Returnera matcherna med `startAt >= since`.

    Hämtas stintar och cachen saknar stintar för en match som inte står i `fetch`, ska den matchen hämtas (cachen kan ha byggts utan stintar).
- `loadHistory(db, since)` och `loadStints(db, since, opts)` behåller sina signaturer. När `historyCacheFile()` inte är null bygger de sitt resultat ur `syncCache`. Annars körs dagens databasväg oförändrad.

- [ ] **Steg 1: Skriv testerna i `tests/nbaHistoryCache.test.ts`.**

```ts
expect(planRefresh(new Map([[1, "a"], [2, "b"], [3, "c"]]), [{ id: 1, version: "a" }, { id: 2, version: "B" }, { id: 4, version: "d" }]))
  .toEqual({ fetch: [2, 4], drop: [3] });
// readCache: saknad fil, "{trasig", och { version: 0, games: [...] } ger alla size 0
// writeCache följt av readCache ger samma Map tillbaka (tmp-katalog via fs.mkdtempSync)
```

- [ ] **Steg 2:** `npx vitest run tests/nbaHistoryCache.test.ts`. Förväntat: FAIL.
- [ ] **Steg 3: Implementera `historyCache.ts`.** Bryt ut omvandlingen i `loadHistory`, från råa rader till `History`, till en egen funktion i `store.ts`, så att både databasvägen och cachevägen använder den.
- [ ] **Steg 4:** `npx vitest run`. Förväntat: hela sviten är grön.
- [ ] **Steg 5:** `npx tsc --noEmit -p .`. Förväntat: inga nya fel.
- [ ] **Steg 6: Committa.** Själva besparingen kan inte verifieras förrän NBA-DB:n öppnar den 1 december. Notera det i commit-meddelandet.

### Task 4: Färskhetsindikator på /skott, /cs2 och /nba

**Filer:**
- Skapa: `app/api/freshness/route.ts`, `components/Freshness.tsx`, `tests/freshness.test.ts`
- Ändra: `lib/localJobs.ts`, `app/(app)/skott/page.tsx`, `app/(app)/cs2/page.tsx`, `app/(app)/nba/page.tsx`

**Gränssnitt:**
- Lägg till i `lib/localJobs.ts`:
  - `STALE_HOURS = 30`
  - `interface Freshness { lastOkAt: string | null; lastRunAt: string | null; failed: boolean; error: string | null; tone: "" | "warn" | "neg"; label: string }`
  - `summarizeFreshness(rows: { ranAt: Date; summary: string }[], now: Date): Freshness`. `rows` är sorterade med den nyaste först.
  - `agoLabel(from: Date | null, now: Date): string`. Ger `"aldrig"`, `"nyss"` (under 1 h), `"5 h sedan"` (under 48 h) eller `"3 d sedan"`.
- Route: `GET /api/freshness?job=cs2:update`. Kräver `getSessionUserId()`. `job` måste matcha `/^(nba|cs2|shots):[a-z-]+$/`, annars blir det 400. Läser de 20 senaste `SyncLog`-raderna med `kind = syncKind(job)` och svarar med `Freshness` som JSON.
- Komponent: `<Freshness job="cs2:update" />` renderar `<InlineStat label="Uppdaterad" value={label} tone={tone} />`. Vid `failed` visas `title={error}`.
- Placering: i `Topbar` `actions` på varje sida. Jobben är `shots:ingest`, `cs2:update` och `nba:update`.

- [ ] **Steg 1: Skriv testerna i `tests/freshness.test.ts`.**

```ts
const now = new Date("2026-11-18T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3600e3);
expect(summarizeFreshness([], now)).toMatchObject({ lastOkAt: null, tone: "warn", label: "aldrig" });
expect(summarizeFreshness([{ ranAt: h(2), summary: "ok · 40 s" }], now)).toMatchObject({ tone: "", label: "2 h sedan", failed: false });
expect(summarizeFreshness([{ ranAt: h(31), summary: "ok · 40 s" }], now)).toMatchObject({ tone: "warn", label: "31 h sedan" });
expect(summarizeFreshness([{ ranAt: h(1), summary: "FEL · exit 1 · 3 s · boom" }, { ranAt: h(20), summary: "ok · 9 s" }], now))
  .toMatchObject({ tone: "neg", failed: true, label: "20 h sedan", error: "FEL · exit 1 · 3 s · boom" });
expect(agoLabel(h(0.5), now)).toBe("nyss");
expect(agoLabel(h(72), now)).toBe("3 d sedan");
```

- [ ] **Steg 2:** `npx vitest run tests/freshness.test.ts`. Förväntat: FAIL.
- [ ] **Steg 3: Implementera funktionerna, routen och komponenten,** och lägg in komponenten på de tre sidorna.
- [ ] **Steg 4:** `npx vitest run` och `npx tsc --noEmit -p .`. Förväntat: grönt.
- [ ] **Steg 5: Verifiera i webbläsaren.**
  - Starta dev-servern med preview_start.
  - På /skott, /cs2 och /nba ska "Uppdaterad" synas.
  - /nba ska vara röd med felraden som tooltip, efter Task 1:s testkörning.
  - Ett jobb som aldrig körts ska stå som "aldrig" i gult.
  - Kontrollera också mobilbredd (375 px).
- [ ] **Steg 6: Committa.**

### Task 5: Installera, första körningarna och minnet

- [ ] **Steg 1: Installera och starta.** Kör `npm run install:tasks -- -NbaResumeAt "2026-12-01 06:00"` från huvudmappen, inte från worktreen. Uppgifterna kör `%~dp0\..`, och det måste vara huvudcheckouten efter merge. Kör sedan `Start-ScheduledTask BettingTracker-Shots` och `BettingTracker-Cs2Update`.
- [ ] **Steg 2: Kontrollera resultatet.** `.claude/logs/shots.log` och `cs2.log` ska sluta med `exit=0`, det ska finnas `ok`-rader i `SyncLog`, och /skott och /cs2 ska visa "nyss".
- [ ] **Steg 3: Uppdatera minnet.** Uppdatera `nba-db-kvot-slut.md` (orsaken är dataöverföring, NBA återstartar automatiskt 1 december, cachen) och lägg till en anteckning om de lokala jobben och `lokal:*`-raderna.
