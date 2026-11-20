# CS2 del 1: siffror att lita på – implementationsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Matchsidan visar bara rätt tolkade linjer, en gång var, och HLTV-jobbet går klart trots enstaka sidfel.

**Architecture:** Rätta tolkningen i Kambi-lagret, filtrera till senaste versionen innan `buildMatchupView`, lås sparningen per match i en kort transaktion, fånga sidfel per steg i `runIngest`, och rensa gamla felrader med ett engångsskript (backup först).

**Tech Stack:** Next.js 14 App Router, Prisma (separat CS2-klient `.prisma/cs2-client`, Neon Postgres), vitest, tsx-skript.

**Spec:** `docs/superpowers/specs/2026-11-20-cs2-palitlighet-design.md`

## Global Constraints

- All UI- och loggtext på svenska, med å/ä/ö.
- Gamla linjeversioner raderas inte, förutom de exakta dubbletterna i rensningen.
- Ingen synlig webbläsare i det schemalagda jobbet.
- Rensningen raderar ingenting utan `--confirm` och skriver backup innan den raderar.
- Lokala körningar går mot prod-Neon (`.env` i huvudmappen). Skrivande körningar görs bara där planen säger det.

## Review Focus

1. Bo5 med karthandikapp ±2,5 är en riktig marknad. Varken spärren eller rensningen får ta bort den.
2. Bo1 har ingen karthandikapp. En `match_handicap` på en Bo1 är alltid fel och ska aldrig sparas.
3. Linjer från skärmdump eller handinmatning, med annan bok än Unibet, ska fortfarande synas på matchsidan, en per bok.
4. Om HLTV:s rankingsida inte går att hämta ska jobbet falla tillbaka på redan bevakade lag, inte krascha.
5. När alla sidor fallerar (Cloudflare blockerar allt) ska jobbet räknas som misslyckat och skicka notis.

---

### Task 1: Rundhandikapp i Kambi-lagret och spärr mot omöjliga karthandikapp

**Files:**
- Modify: `lib/cs2/kambi.ts` (`marketOf`, `mapBetOffers`)
- Modify: `lib/cs2/lineInput.ts` (ny `maxMatchHandicap`)
- Modify: `lib/cs2/lineStore.ts` (`kambiRowsForMatch`: läs `format`, skicka vidare, spärra)
- Modify: `app/api/cs2/lines/fetch-kambi/route.ts` (välj `format`)
- Modify: `app/api/cs2/lines/route.ts` (spärra handinmatade/skärmdumpade rader)
- Modify: `lib/cs2/propsExtract.ts` (en rad i prompten)
- Test: `tests/cs2Kambi.test.ts`, `tests/cs2LineStore.test.ts`

**Interfaces:**
- Produces: `maxMatchHandicap(format: string): number` i `lib/cs2/lineInput.ts`. Ger bo1 → 0, bo3 → 1.5, bo5 → 2.5, annat → 2.5.
- Produces: `mapBetOffers(offers, event, format?: string)`. Utan `format` gäller samma regel som Bo3.
- `kambiRowsForMatch(db, match, events)`: `match` får fältet `format: string`.

- [ ] **Step 1: Skriv testerna som ska fallera**

I `tests/cs2Kambi.test.ts`:
```ts
it("rundhandikapp över hela matchen är inte karthandikapp", () => {
  expect(marketOf("Round Handicap", false)).toBe("other");
  expect(marketOf("Map Handicap", false)).toBe("match_handicap");
  expect(marketOf("Map 1 - Round Handicap", false)).toBe("map_handicap");
});
it("rundhandikapp i Bo1 blir kartans rundhandikapp", () => {
  const offer: KambiBetOffer = { criterion: { englishLabel: "Round Handicap" }, betOfferType: { englishName: "Handicap" },
    outcomes: [{ type: "OT_ONE", line: -4500, odds: 2180, participant: "HEROIC" }, { type: "OT_TWO", line: 4500, odds: 1620, participant: "Imperial" }] };
  const ev = { homeName: "HEROIC", awayName: "Imperial" };
  expect(mapBetOffers([offer], ev, "bo1")[0]).toMatchObject({ market: "map_handicap", scope: "map1", line: -4.5 });
  expect(mapBetOffers([offer], ev, "bo3")[0].market).toBe("other");
});
```
I `tests/cs2LineStore.test.ts`:
```ts
it("högsta möjliga karthandikapp per format", () => {
  expect(maxMatchHandicap("bo1")).toBe(0);
  expect(maxMatchHandicap("bo3")).toBe(1.5);
  expect(maxMatchHandicap("bo5")).toBe(2.5);
});
```

- [ ] **Step 2: Kör och se dem fallera**

Run: `npx vitest run tests/cs2Kambi.test.ts tests/cs2LineStore.test.ts`
Expected: FAIL. "Round Handicap" ger `match_handicap`, och `maxMatchHandicap` finns inte.

- [ ] **Step 3: Implementera**

- `marketOf`: handikappgrenen blir `onMap ? "map_handicap" : /round|runda|rund/.test(l) ? "other" : "match_handicap"`.
- `mapBetOffers`: om etiketten är rundhandikapp utan kartnummer och `format === "bo1"` blir `market` `"map_handicap"` och `scope` `"map1"`. Grupperingen på absolutvärdet ska gälla även då.
- `kambiRowsForMatch`: välj `format` på matchen och skicka det till `mapBetOffers`. Efter `skipReason`: en rad med `market === "match_handicap"` och `Math.abs(line) > maxMatchHandicap(format)` får skip `"handikappet är större än serien tillåter (rundhandikapp?)"`. Lägg till `format: true` i `select` i `captureKambiLines` och i fetch-kambi-routen.
- `app/api/cs2/lines/route.ts`: läs matchens `format` och avvisa samma fall med 400 och samma text.
- `propsExtract.ts`: lägg till i prompten: `- Rundhandikapp för hela matchen (inte en enskild karta) → "other".`

- [ ] **Step 4: Kör testerna**

Run: `npx vitest run tests/cs2Kambi.test.ts tests/cs2LineStore.test.ts`
Expected: PASS, inklusive de befintliga testerna.

- [ ] **Step 5: Commit**

`git commit -m "CS2: Unibets rundhandikapp läses inte längre som karthandikapp"`

---

### Task 2: Matchsidan visar bara senaste versionen per linje och bok

**Files:**
- Modify: `lib/cs2/lineInput.ts` (ny `latestLineVersions`)
- Modify: `app/api/cs2/matches/[id]/route.ts`
- Modify: `lib/cs2/queries.ts` (antalet linjer i matchlistan, runt rad 534/574)
- Test: `tests/cs2LineStore.test.ts`

**Interfaces:**
- Produces: `latestLineVersions<T extends LineIdentity & { id: number; bookmaker: string | null }>(rows: T[]): T[]`. Behåller raden med högst `id` per `(bok utan skiftläge/mellanslag) + lineKey`. Ordningen på resultatet är fallande `id`.

- [ ] **Step 1: Skriv testerna som ska fallera**

```ts
describe("senaste versionen på matchsidan", () => {
  const base = { market: "kills", scope: "map1", playerId: 7, player2Id: null, teamId: null, line: 15.5 };
  it("en rad per linje och bok, den senaste", () => {
    const out = latestLineVersions([{ ...base, id: 1, bookmaker: "Unibet" }, { ...base, id: 5, bookmaker: "Unibet" }, { ...base, id: 3, bookmaker: "unibet " }]);
    expect(out.map((r) => r.id)).toEqual([5]);
  });
  it("olika böcker och linjer hålls isär", () => {
    const out = latestLineVersions([{ ...base, id: 1, bookmaker: "Unibet" }, { ...base, id: 2, bookmaker: "Bet365" }, { ...base, id: 3, line: 16.5, bookmaker: "Unibet" }]);
    expect(out.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Kör och se dem fallera**

Run: `npx vitest run tests/cs2LineStore.test.ts`
Expected: FAIL, `latestLineVersions` finns inte.

- [ ] **Step 3: Implementera**

- `latestLineVersions` i `lineInput.ts`.
- Routen: `rows` → `latestLineVersions(rows)` innan mappningen till `LineInput`.
- `queries.ts`: ersätt `_count.lines` med antalet efter `latestLineVersions` på linjerna för listans matcher. Gör det med en `findMany` för alla matcher i listan, med `select` på identitetsfälten, `id`, `bookmaker` och `matchId`.

- [ ] **Step 4: Kör testerna**

Run: `npx vitest run tests/cs2LineStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

`git commit -m "CS2: matchsidan visar senaste oddsen per linje, inte varje version"`

---

### Task 3: Lås när Unibet-linjer sparas

**Files:**
- Modify: `lib/cs2/lineStore.ts` (`saveLines`, `captureKambiLines`)

**Interfaces:**
- `saveLines(db: Cs2Writer, ctx, lines, createdBy)`, där `type Cs2Writer = Pick<PrismaClient, "cs2Line" | "cs2Projection">`, så att både klienten och transaktionsklienten passar. Övriga anrop (`app/api/cs2/lines/route.ts`) är oförändrade.

- [ ] **Step 1: Implementera**

I loopen i `captureKambiLines`, efter `kambiRowsForMatch` och valideringen:
1. `loadMatchupContext` körs *före* transaktionen. Den är tung och oberoende av sparade linjer.
2. `db.$transaction(async (tx) => { await tx.$executeRaw\`SELECT pg_advisory_xact_lock(${m.id})\`; läs saved med tx; toSave = changedLines(valid, saved); if (toSave.length) await saveLines(tx, ctx, toSave, "auto"); return { toSave, total: valid.length }; }, { timeout: 30_000 })`.
3. Loggraderna och summeringen fungerar som i dag.

Om `ctx` är null hoppas matchen över som i dag, före transaktionen.

- [ ] **Step 2: Typkontroll och befintliga tester**

Run: `npx tsc --noEmit -p . && npx vitest run tests/cs2LineStore.test.ts`
Expected: inga typfel, PASS

- [ ] **Step 3: Prova mot riktig data**

Run (två körningar samtidigt, i worktreen med `.env` laddad): `npm run cs2:lines & npm run cs2:lines & wait`
Därefter räknar `.claude/tmp/dupes.ts` om exactDupes.
Expected: `exactDupes` är oförändrat (11 före rensningen, 0 efter).

- [ ] **Step 4: Commit**

`git commit -m "CS2: två linjehämtningar samtidigt sparar inte samma odds två gånger"`

---

### Task 4: HLTV-jobbet tål enskilda sidfel

**Files:**
- Modify: `lib/cs2/pipeline.ts` (`runIngest` steg 1–4, ny `collectResultIds`, ny `ingestFailed`)
- Modify: `lib/cs2/hltv/session.ts` (`fetchViaScrapling`, ny `isRetryableScraplingError`)
- Modify: `scripts/cs2/update.ts`
- Test: `tests/cs2Hltv.test.ts`

**Interfaces:**
- Produces: `collectResultIds(session: Pick<HltvSession, "getHtml">, teamIds: number[], since: Date, log: Log, errors: string[]): Promise<Map<number, string | null>>`. Ett lag vars resultatsida kastar ger raden `Resultat för lag <id>: <fel>` i `errors`, och loopen fortsätter. `HltvBudgetError` kastas vidare.
- Produces: `ingestFailed(s: IngestSummary): boolean`. Ger true om `s.fetched + s.cacheHits === 0`, eller om `s.errors.length > (s.fetched + s.cacheHits) / 2`.
- Produces: `isRetryableScraplingError(e: unknown): boolean`. Ger true för `ScraplingError` med `code` `"timeout"` eller `"worker_died"`.

- [ ] **Step 1: Skriv testerna som ska fallera**

```ts
describe("HLTV-jobbet tål sidfel", () => {
  it("ett lag vars resultatsida kastar hoppas över", async () => {
    const session = { getHtml: async (u: string) => { if (u.includes("team=1")) throw new Error("Scrapling svarade inte inom 180 s"); return ""; } };
    const errors: string[] = [];
    const ids = await collectResultIds(session, [1, 2], new Date("2026-05-01"), () => {}, errors);
    expect(ids.size).toBe(0);
    expect(errors).toEqual([expect.stringContaining("lag 1")]);
  });
  it("budgetfelet stoppar fortfarande", async () => {
    const session = { getHtml: async () => { throw new HltvBudgetError(600); } };
    await expect(collectResultIds(session, [1], new Date(), () => {}, [])).rejects.toBeInstanceOf(HltvBudgetError);
  });
  it("misslyckat bara när nästan inget gick", () => {
    const s = (fetched: number, errors: number) => ({ fetched, cacheHits: 0, errors: Array(errors).fill("x") }) as IngestSummary;
    expect(ingestFailed(s(0, 0))).toBe(true);
    expect(ingestFailed(s(100, 3))).toBe(false);
    expect(ingestFailed(s(10, 6))).toBe(true);
  });
  it("timeout och död worker försöks igen, annat inte", () => {
    expect(isRetryableScraplingError(new ScraplingError("x", "timeout"))).toBe(true);
    expect(isRetryableScraplingError(new ScraplingError("x", "worker_died"))).toBe(true);
    expect(isRetryableScraplingError(new ScraplingError("x", "scrapling_missing"))).toBe(false);
    expect(isRetryableScraplingError(new Error("x"))).toBe(false);
  });
});
```
(Kontrollera `HltvBudgetError`s konstruktor och var den bor innan testet skrivs.)

- [ ] **Step 2: Kör och se dem fallera**

Run: `npx vitest run tests/cs2Hltv.test.ts`
Expected: FAIL, funktionerna finns inte.

- [ ] **Step 3: Implementera**

- `collectResultIds` ersätter de två `for … resultMatchIds`-looparna i `runIngest` (bevakade lag och motståndare).
- Steg 1: om hämtningen av rankingsidan kastar (inte budgetfel) loggas felet och läggs i `summary.errors`, och sedan används `trackedTeamIds(db)`.
- Steg 2 och 4: try/catch per lag respektive kommande match, med samma mönster som steg 5.
- `fetchViaScrapling`: fånga fel från `worker.fetch`. Om `isRetryableScraplingError(e)` och `attempt < 2`, logga `"    Scrapling fastnade — startar om och försöker igen (n/3)."` och gör `continue`. Annars kastas felet vidare.
- `update.ts`: lägg `runIngest` i en egen try/catch. Kastar den, eller om `ingestFailed(s)` är sant, sätts `hltvFailed = true`. Steg 2 (demos) körs bara om `!hltvFailed`. Steg 3–5 körs alltid. Om `hltvFailed` loggas `HLTV-steget misslyckades: <första felet>` sist, och `process.exitCode = 1`. Annars, om `s.errors.length > 0`, blir sista raden `   klart · ${s.errors.length} HLTV-sidor hoppades över`.

- [ ] **Step 4: Kör testerna och typkontrollen**

Run: `npx vitest run tests/cs2Hltv.test.ts && npx tsc --noEmit -p .`
Expected: PASS, inga typfel

- [ ] **Step 5: Commit**

`git commit -m "CS2: en HLTV-sida som fastnar stoppar inte resten av uppdateringen"`

---

### Task 5: Rensa felraderna, med backup

**Files:**
- Create: `lib/cs2/cleanup.ts` (ren urvalslogik)
- Create: `scripts/cs2/cleanup-2026-11-20.ts`
- Test: `tests/cs2Cleanup.test.ts`

**Interfaces:**
- Produces: `selectCleanup(lines: CleanupLine[], formats: Map<number, string>): { roundHandicap: number[]; duplicates: number[] }`, där `CleanupLine = LineIdentity & { id: number; matchId: number; bookmaker: string | null; overOdds: number | null; underOdds: number | null; createdAt: Date }`.
  - `roundHandicap`: `match_handicap` med Bo1 och vilken linje som helst, Bo3 med |linje| ≥ 2,5, Bo5 med |linje| ≥ 3,5. I Bo5 tillkommer |linje| = 2,5 om en rad i samma match med |linje| ≥ 3,5 skapades inom 10 s.
  - `duplicates`: inom samma match + bok + `lineKey`, sorterat på `id`, varje rad med samma odds som närmast föregående version.

- [ ] **Step 1: Skriv testerna som ska fallera**

```ts
const t0 = new Date("2026-11-18T22:58:44Z");
const L = (id: number, matchId: number, line: number, extra: Partial<CleanupLine> = {}): CleanupLine =>
  ({ id, matchId, market: "match_handicap", scope: "match", playerId: null, player2Id: null, teamId: 9, line, bookmaker: "Unibet", overOdds: 1.5, underOdds: 2.5, createdAt: t0, ...extra });
it("rundstegen bort, riktiga karthandikapp kvar", () => {
  const f = new Map([[1, "bo3"], [2, "bo5"], [3, "bo1"], [4, "bo5"]]);
  const r = selectCleanup([L(1, 1, -1.5), L(2, 1, -2.5), L(3, 2, 2.5), L(4, 2, -4.5), L(5, 3, -2.5), L(6, 4, 2.5)], f);
  expect(r.roundHandicap.sort()).toEqual([2, 3, 4, 5]);
});
it("exakt samma odds i nästa version är en dubblett, ändrade odds inte", () => {
  const k = { market: "kills", teamId: null, playerId: 7 } as const;
  const r = selectCleanup([L(10, 1, 15.5, k), L(11, 1, 15.5, k), L(12, 1, 15.5, { ...k, overOdds: 1.9 })], new Map([[1, "bo3"]]));
  expect(r.duplicates).toEqual([11]);
});
```

- [ ] **Step 2: Kör och se dem fallera**

Run: `npx vitest run tests/cs2Cleanup.test.ts`
Expected: FAIL, modulen finns inte.

- [ ] **Step 3: Implementera `selectCleanup` och skriptet**

Skriptet läser alla `Cs2Line` och matchernas `format` och kör `selectCleanup`. Det skriver ut antal per grupp och per format, och listar Bo5-raderna på ±2,5 med beslutet för varje. Utan `--confirm` slutar skriptet där.

Med `--confirm` gäller:
- Backupen skrivs först, som JSON med linjerna och deras `Cs2Projection` (`lineId in ids`), till `--backup-dir` (standard `.claude/backups`). Filnamnet är `cs2-cleanup-2026-11-20-<tidsstämpel>.json`.
- Därefter raderas projektionerna och linjerna i en transaktion.
- Sist skrivs antalet raderade rader ut.

- [ ] **Step 4: Kör testerna**

Run: `npx vitest run tests/cs2Cleanup.test.ts`
Expected: PASS

- [ ] **Step 5: Torrkörning mot prod**

Run: `npx tsx scripts/cs2/cleanup-2026-11-20.ts`
Expected: 101 säkra rundhandikapprader och högst 5 Bo5-rader på ±2,5 som pekas ut, samt 11 dubbletter (överlapp räknas en gång). Om siffrorna avviker kraftigt från det: stanna och fråga Jonatan.

- [ ] **Step 6: Skarp körning**

Run: `npx tsx scripts/cs2/cleanup-2026-11-20.ts --confirm --backup-dir "C:/Users/ompam/Documents/Betting Tracker/.claude/backups"`
Expected: backupfilen finns och samma antal har raderats.

- [ ] **Step 7: Commit**

`git commit -m "CS2: rensa rundhandikapp som sparats som karthandikapp och dubblettlinjer"`

---

### Task 6: Verifiera hela kedjan

- [ ] `npx vitest run` → alla tester gröna.
- [ ] `npx tsc --noEmit -p .` → inga fel.
- [ ] Matchsidan PARIVISION–DENDELE (`/cs2/match/2400499`) i preview: en matchvinnarlinje, inga handikapp ≥ ±2,5, ingen Angles-rad står två gånger.
- [ ] Matchlistan: PARIVISION–DENDELE visar 1 linje i stället för 22.
- [ ] Facit-fliken laddar, och antalet avgjorda linjer har minskat med 13–18.
- [ ] Sammanfatta för Jonatan. Påminn om `git pull` i huvudmappen före klockan 10.
