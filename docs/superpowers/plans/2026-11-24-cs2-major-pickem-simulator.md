# CS2 Major Stage 1 Pick'em-simulator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ett engångsskript som simulerar Stage 1 av PGL Major Singapore 2026 och skriver ut de tio pick'em-val som maximerar P(≥5 rätt).

**Architecture:** All ren logik (Swiss-format, parning, simulering, kalibrering, optimerare) i en ny `lib/cs2/pickem.ts` med vitest-täckning. Allt som rör omvärlden (CS2-databasen, Kambi, utskrift) i ett skript, `scripts/cs2/pickem-2026-11-24.ts`. Inga ändringar i befintliga filer: sannolikhetsmotorn byggs genom att anropa `globalModel`, `vetoProfile`, `vetoDistribution`, `mapDistribution` och `seriesProbs` som de är.

**Tech Stack:** TypeScript, tsx, vitest, Prisma (cs2-client), Kambis offering-API via `lib/cs2/kambi.ts`.

**Spec:** `docs/superpowers/specs/2026-11-24-cs2-major-pickem-simulator-design.md`

## Global Constraints

- Picks låser **2026-11-24 04:00 UTC**. Skriptet måste gå att köra färdigt före dess.
- Pick'em-etappen är exakt tio val: **2 på 3-0**, **6 på 3-1/3-2**, **2 på 0-3**. Målet är **P(≥5 rätt)**.
- Ett lag lagt på 3-0 som går 3-1 är **fel**. Ett 3-0-val räknas aldrig som ett avancerings-val.
- Format: **bo1 överallt utom när avancering eller elimination står på spel** — en match är bo3 om och endast om något av lagen står på 2 vinster eller 2 förluster. `Cs2Match.format` är fel för detta event och får inte läsas.
- 16 lag, 5 ronder, topp 8 avancerar. **200 000** simuleringar.
- Avviggning sker **additivt på log-odds**, aldrig multiplikativt.
- Svenska i utskrifter och kommentarer, som resten av kodbasen.

## Review Focus

1. **Parning utan giltigt par** — rematch-undvikandet får inte kasta eller hänga; en grupp där varje tänkbart par redan mötts måste ändå parras. Täcks i Task 1, steg 5.
2. **Lag som nått 3 vinster eller 3 förluster** får aldrig parras igen. Täcks i Task 1, steg 9.
3. **Simuleringen måste alltid ge exakt 8 avancerade och exakt 8 utslagna**, i varje enskild simulering. Täcks i Task 1, steg 9.
4. **Ett lag på två platser i valet** (samma lag både som 3-0 och som avancerande) måste förkastas av optimeraren. Täcks i Task 2, steg 5.
5. **Kambi saknar pris på en match** (ena sidan null, eller matchen hittas inte) — kalibreringen ska falla tillbaka på k=1 med en varning, inte krascha eller tysta fitta på för få punkter. Täcks i Task 3, steg 5.

---

### Task 1: Swiss-format, parning och simulering

**Files:**
- Create: `lib/cs2/pickem.ts`
- Test: `tests/cs2Pickem.test.ts`

**Interfaces:**
- Consumes: inget från tidigare tasks.
- Produces:
  - `export type Outcome = "3-0" | "adv" | "0-3" | "out"` — `"adv"` = 3 vinster med 1–2 förluster, `"out"` = utslagen på 1-3 eller 2-3.
  - `export function isBo3(wins: number, losses: number): boolean`
  - `export interface SwissTeam { id: number; seed: number }`
  - `export function buchholz(record: Map<number, { w: number; l: number }>, opponents: number[]): number`
  - `export function pairGroup(group: Array<{ id: number; buchholz: number; seed: number }>, played: Set<string>): Array<[number, number]>`
  - `export function simulateSwiss(teams: SwissTeam[], round1: Array<[number, number]>, pWin: (a: number, b: number, format: "bo1" | "bo3") => number, rng: () => number): Map<number, Outcome>`

- [ ] **Step 1: Skriv det fallerande testet för `isBo3`**

```ts
describe("isBo3", () => {
  it("är bo3 när avancering eller elimination står på spel", () => {
    expect(isBo3(2, 0)).toBe(true);
    expect(isBo3(0, 2)).toBe(true);
    expect(isBo3(2, 1)).toBe(true);
    expect(isBo3(1, 2)).toBe(true);
    expect(isBo3(2, 2)).toBe(true);
  });
  it("är bo1 i övriga ronder", () => {
    expect(isBo3(0, 0)).toBe(false);
    expect(isBo3(1, 0)).toBe(false);
    expect(isBo3(0, 1)).toBe(false);
    expect(isBo3(1, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Kör testet och se att det fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t isBo3`
Expected: FAIL — `isBo3` finns inte.

- [ ] **Step 3: Implementera `isBo3(wins: number, losses: number): boolean` i `lib/cs2/pickem.ts`**

- [ ] **Step 4: Kör testet och se att det passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t isBo3`
Expected: PASS

- [ ] **Step 5: Skriv de fallerande testerna för `buchholz` och `pairGroup`**

`buchholz` summerar motståndarnas (vinster − förluster).

```ts
describe("buchholz", () => {
  it("summerar motståndarnas facit", () => {
    const rec = new Map([[1, { w: 2, l: 0 }], [2, { w: 0, l: 2 }], [3, { w: 1, l: 1 }]]);
    expect(buchholz(rec, [1, 2, 3])).toBe(0);
    expect(buchholz(rec, [1, 1])).toBe(4);
    expect(buchholz(rec, [])).toBe(0);
  });
});

describe("pairGroup", () => {
  it("parar högsta mot lägsta efter buchholz, därefter seed", () => {
    const g = [
      { id: 1, buchholz: 2, seed: 1 },
      { id: 2, buchholz: 1, seed: 5 },
      { id: 3, buchholz: 0, seed: 3 },
      { id: 4, buchholz: -1, seed: 9 },
    ];
    expect(pairGroup(g, new Set())).toEqual([[1, 4], [2, 3]]);
  });
  it("skiljer lika buchholz på seed, lägst seed först", () => {
    const g = [
      { id: 7, buchholz: 0, seed: 12 },
      { id: 8, buchholz: 0, seed: 2 },
    ];
    expect(pairGroup(g, new Set())).toEqual([[8, 7]]);
  });
  it("byter par för att undvika omatch", () => {
    const g = [
      { id: 1, buchholz: 3, seed: 1 },
      { id: 2, buchholz: 2, seed: 2 },
      { id: 3, buchholz: 1, seed: 3 },
      { id: 4, buchholz: 0, seed: 4 },
    ];
    // 1 och 4 har redan mötts: 1 ska i stället möta 3, och 2 möta 4.
    expect(pairGroup(g, new Set(["1|4"]))).toEqual([[1, 3], [2, 4]]);
  });
  it("parar ändå när varje tänkbart par redan mötts", () => {
    const g = [
      { id: 1, buchholz: 1, seed: 1 },
      { id: 2, buchholz: 0, seed: 2 },
    ];
    const pairs = pairGroup(g, new Set(["1|2"]));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].slice().sort()).toEqual([1, 2]);
  });
});
```

- [ ] **Step 6: Kör testerna och se att de fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t "buchholz|pairGroup"`
Expected: FAIL — funktionerna finns inte.

- [ ] **Step 7: Implementera `buchholz` och `pairGroup` i `lib/cs2/pickem.ts`**

`pairGroup`: sortera gruppen på buchholz fallande, därefter seed stigande. Para index `i` mot index `n-1-i`. Nyckeln i `played` är de två id:na i numerisk ordning med ett lodstreck emellan. Vid omatch: byt det lägre indexets motståndare mot nästa pars motståndare och försök igen; om ingen bytessekvens ger en omatchfri parning, behåll den ursprungliga parningen — en omatch är bättre än ett undantag.

- [ ] **Step 8: Kör testerna och se att de passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t "buchholz|pairGroup"`
Expected: PASS

- [ ] **Step 9: Skriv de fallerande testerna för `simulateSwiss`**

Lägg `mulberry32(seed: number): () => number` som en deterministisk testhjälpare i testfilen.

```ts
const SEEDS: SwissTeam[] = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, seed: i + 1 }));
const R1: Array<[number, number]> = [[1, 9], [2, 10], [3, 11], [4, 12], [5, 13], [6, 14], [7, 15], [8, 16]];

describe("simulateSwiss", () => {
  it("ger alltid exakt 8 avancerade och 8 utslagna", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const out = simulateSwiss(SEEDS, R1, () => 0.5, rng);
      expect(out.size).toBe(16);
      expect([...out.values()].filter((o) => o === "3-0" || o === "adv").length).toBe(8);
      expect([...out.values()].filter((o) => o === "0-3" || o === "out").length).toBe(8);
    }
  });
  it("ger minst ett 3-0 och minst ett 0-3", () => {
    const out = simulateSwiss(SEEDS, R1, () => 0.5, mulberry32(7));
    expect([...out.values()].filter((o) => o === "3-0").length).toBeGreaterThanOrEqual(1);
    expect([...out.values()].filter((o) => o === "0-3").length).toBeGreaterThanOrEqual(1);
  });
  it("låter det starkare laget gå 3-0 när det alltid vinner", () => {
    const out = simulateSwiss(SEEDS, R1, (a) => (a === 1 ? 1 : 0.5), mulberry32(3));
    expect(out.get(1)).toBe("3-0");
  });
  it("spelar mellan tre och fem matcher per lag, aldrig mer", () => {
    const counts = new Map<number, number>();
    simulateSwiss(SEEDS, R1, (a, b) => {
      counts.set(a, (counts.get(a) ?? 0) + 1);
      counts.set(b, (counts.get(b) ?? 0) + 1);
      return 0.5;
    }, mulberry32(11));
    for (const n of counts.values()) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });
  it("väljer format efter facit: rond 1 är alltid bo1, senare ronder har bo3", () => {
    const formats: string[] = [];
    simulateSwiss(SEEDS, R1, (_a, _b, f) => {
      formats.push(f);
      return 0.5;
    }, mulberry32(5));
    expect(formats.slice(0, 8).every((f) => f === "bo1")).toBe(true);
    expect(formats.some((f) => f === "bo3")).toBe(true);
  });
});
```

- [ ] **Step 10: Kör testerna och se att de fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t simulateSwiss`
Expected: FAIL — `simulateSwiss` finns inte.

- [ ] **Step 11: Implementera `simulateSwiss` i `lib/cs2/pickem.ts`**

Rond 1 använder `round1` som den är, alltid `"bo1"`. Rond 2–5: gruppera aktiva lag (färre än 3 vinster och färre än 3 förluster) på `w-l`, räkna buchholz ur motståndarlistorna, `pairGroup` per grupp, format ur `isBo3(w, l)` för gruppen. En match avgörs av `rng() < pWin(a, b, format)`. Slutfacit per lag: 3 vinster och 0 förluster → `"3-0"`, 3 vinster → `"adv"`, 0 vinster och 3 förluster → `"0-3"`, annars `"out"`.

- [ ] **Step 12: Kör hela testfilen och se att den passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add lib/cs2/pickem.ts tests/cs2Pickem.test.ts
git commit -m "CS2: Swiss-simulering för Majorns pick'em"
```

---

### Task 2: Pick'em-poäng och optimerare

**Files:**
- Modify: `lib/cs2/pickem.ts`
- Test: `tests/cs2Pickem.test.ts`

**Interfaces:**
- Consumes: `Outcome` från Task 1.
- Produces:
  - `export interface PickSet { threeZero: number[]; advance: number[]; zeroThree: number[] }`
  - `export function scorePicks(picks: PickSet, outcomes: Map<number, Outcome>): number`
  - `export interface OutcomeTable { teams: number[]; p30: Map<number, number>; pAdv: Map<number, number>; p03: Map<number, number>; codes: Uint8Array; sims: number }` — `codes[sim * teams.length + i]` är lagets utfall i den simuleringen, kodat `0 = "3-0"`, `1 = "adv"`, `2 = "0-3"`, `3 = "out"`.
  - `export function tally(sims: Array<Map<number, Outcome>>, teams: number[]): OutcomeTable`
  - `export function pHitAtLeast(table: OutcomeTable, picks: PickSet, atLeast: number): number`
  - `export function expectedHits(table: OutcomeTable, picks: PickSet): number`
  - `export function greedyPicks(table: OutcomeTable): PickSet` — topp 2 på `p30`, topp 2 på `p03` bland återstående, topp 6 på `pAdv` bland återstående.
  - `export function optimizePicks(table: OutcomeTable, atLeast: number, rng: () => number): { picks: PickSet; pHit: number; expected: number }`

- [ ] **Step 1: Skriv de fallerande testerna för `scorePicks`**

```ts
describe("scorePicks", () => {
  const out = new Map<number, Outcome>([[1, "3-0"], [2, "adv"], [3, "0-3"], [4, "out"], [5, "adv"]]);
  it("räknar rätt val i varje slot", () => {
    expect(scorePicks({ threeZero: [1], advance: [2, 5], zeroThree: [3] }, out)).toBe(4);
  });
  it("räknar ett 3-0-val som fel när laget går 3-1", () => {
    expect(scorePicks({ threeZero: [2], advance: [], zeroThree: [] }, out)).toBe(0);
  });
  it("räknar inte ett 3-0-lag som ett avancerings-val", () => {
    expect(scorePicks({ threeZero: [], advance: [1], zeroThree: [] }, out)).toBe(0);
  });
  it("räknar inte ett lag utslaget på 2-3 som 0-3", () => {
    expect(scorePicks({ threeZero: [], advance: [], zeroThree: [4] }, out)).toBe(0);
  });
});
```

- [ ] **Step 2: Kör testerna och se att de fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t scorePicks`
Expected: FAIL

- [ ] **Step 3: Implementera `scorePicks` i `lib/cs2/pickem.ts`**

- [ ] **Step 4: Kör testerna och se att de passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t scorePicks`
Expected: PASS

- [ ] **Step 5: Skriv de fallerande testerna för `tally`, `pHitAtLeast`, `greedyPicks` och `optimizePicks`**

`favouriteSims()` och `mixedSims()` är hjälpare i testfilen som bygger listor av `Map<number, Outcome>` över 16 lag: `favouriteSims` låter lag 1–2 alltid gå 3-0, lag 3–8 alltid `"adv"` och lag 15–16 alltid 0-3; `mixedSims` blandar utfallen med `mulberry32`.

```ts
describe("tally och pHitAtLeast", () => {
  const sims = [
    new Map<number, Outcome>([[1, "3-0"], [2, "adv"], [3, "0-3"]]),
    new Map<number, Outcome>([[1, "adv"], [2, "3-0"], [3, "0-3"]]),
  ];
  it("ger marginalsannolikheter per lag", () => {
    const t = tally(sims, [1, 2, 3]);
    expect(t.p30.get(1)).toBeCloseTo(0.5);
    expect(t.pAdv.get(1)).toBeCloseTo(0.5);
    expect(t.p03.get(3)).toBeCloseTo(1);
  });
  it("räknar P(minst n rätt) över simuleringarna", () => {
    const t = tally(sims, [1, 2, 3]);
    expect(pHitAtLeast(t, { threeZero: [1], advance: [], zeroThree: [3] }, 2)).toBeCloseTo(0.5);
    expect(pHitAtLeast(t, { threeZero: [1], advance: [], zeroThree: [3] }, 1)).toBeCloseTo(1);
  });
});

describe("optimizePicks", () => {
  it("ger tio olika lag i rätt antal per slot", () => {
    const table = tally(favouriteSims(), TEAM_IDS);
    const best = optimizePicks(table, 5, mulberry32(1));
    const all = [...best.picks.threeZero, ...best.picks.advance, ...best.picks.zeroThree];
    expect(new Set(all).size).toBe(10);
    expect(best.picks.threeZero).toHaveLength(2);
    expect(best.picks.advance).toHaveLength(6);
    expect(best.picks.zeroThree).toHaveLength(2);
    expect(best.pHit).toBeGreaterThan(0.9);
  });
  it("slår det giriga EV-valet eller tangerar det", () => {
    const table = tally(mixedSims(), TEAM_IDS);
    const best = optimizePicks(table, 5, mulberry32(2));
    expect(best.pHit).toBeGreaterThanOrEqual(pHitAtLeast(table, greedyPicks(table), 5) - 1e-9);
  });
});
```

- [ ] **Step 6: Kör testerna och se att de fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t "tally|optimizePicks"`
Expected: FAIL

- [ ] **Step 7: Implementera `tally`, `pHitAtLeast`, `expectedHits`, `greedyPicks` och `optimizePicks` i `lib/cs2/pickem.ts`**

`pHitAtLeast` loopar simuleringarna över `codes` och räknar träffar per slot via förberäknade kolumnindex — ingen `Map`-uppslagning i den inre loopen. `optimizePicks`: starta från `greedyPicks`, sedan brantaste klättring över alla byten där ett valt lag ersätts av ett ovalt i samma slot, plus alla flyttar av ett lag mellan slots; upprepa till ingen förbättring. Tre omstarter från slumpmässiga giltiga uppsättningar, bästa vinner. Ett lag får förekomma på exakt en plats.

- [ ] **Step 8: Kör hela testfilen och se att den passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/cs2/pickem.ts tests/cs2Pickem.test.ts
git commit -m "CS2: pick'em-poäng och optimerare mot P(minst 5 ratt)"
```

---

### Task 3: Marknadskalibrering

**Files:**
- Modify: `lib/cs2/pickem.ts`
- Test: `tests/cs2Pickem.test.ts`

**Interfaces:**
- Consumes: inget.
- Produces:
  - `export function devigLogit(oddsA: number, oddsB: number): { pA: number; pB: number } | null` — null när något odds saknas, inte är ett tal, eller är ≤ 1.
  - `export function calibrate(pModel: number, k: number): number`
  - `export function fitCalibration(points: Array<{ pModel: number; pMarket: number }>): { k: number; n: number; warning: string | null }`

- [ ] **Step 1: Skriv de fallerande testerna för `devigLogit`**

```ts
describe("devigLogit", () => {
  it("ger sannolikheter som summerar till ett", () => {
    const d = devigLogit(1.47, 2.6)!;
    expect(d.pA + d.pB).toBeCloseTo(1, 10);
    expect(d.pA).toBeGreaterThan(1 / 1.47 - 0.05);
    expect(d.pA).toBeLessThan(1 / 1.47 + 0.05);
  });
  it("lämnar ett rättvist par orört", () => {
    expect(devigLogit(2, 2)!.pA).toBeCloseTo(0.5, 10);
  });
  it("flyttar favoriten mindre än multiplikativ de-vig gör", () => {
    const d = devigLogit(1.1, 9)!;
    const mult = 1 / 1.1 / (1 / 1.1 + 1 / 9);
    expect(d.pA).toBeLessThan(mult);
  });
  it("ger null när ett odds saknas eller är orimligt", () => {
    expect(devigLogit(NaN, 2)).toBeNull();
    expect(devigLogit(1, 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Kör testerna och se att de fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t devigLogit`
Expected: FAIL

- [ ] **Step 3: Implementera `devigLogit` i `lib/cs2/pickem.ts`**

Lös `c` ur att `σ(logit(1/oddsA) + c) + σ(logit(1/oddsB) + c) = 1` med bisektion på `c` i intervallet −1 till 1, 60 iterationer.

- [ ] **Step 4: Kör testerna och se att de passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t devigLogit`
Expected: PASS

- [ ] **Step 5: Skriv de fallerande testerna för `calibrate` och `fitCalibration`**

```ts
describe("fitCalibration", () => {
  it("ger k=1 när modellen redan möter marknaden", () => {
    const pts = [0.3, 0.45, 0.6, 0.75].map((p) => ({ pModel: p, pMarket: p }));
    expect(fitCalibration(pts).k).toBeCloseTo(1, 2);
  });
  it("ger k under 1 när modellen är för tvärsäker", () => {
    const pts = [0.1, 0.2, 0.8, 0.9].map((p) => ({ pModel: p, pMarket: calibrate(p, 0.6) }));
    const f = fitCalibration(pts);
    expect(f.k).toBeCloseTo(0.6, 1);
    expect(f.warning).toBeNull();
  });
  it("faller tillbaka på k=1 med varning vid för få punkter", () => {
    const f = fitCalibration([{ pModel: 0.6, pMarket: 0.5 }]);
    expect(f.k).toBe(1);
    expect(f.n).toBe(1);
    expect(f.warning).not.toBeNull();
  });
});
```

- [ ] **Step 6: Kör testerna och se att de fallerar**

Run: `npx vitest run tests/cs2Pickem.test.ts -t "fitCalibration|calibrate"`
Expected: FAIL

- [ ] **Step 7: Implementera `calibrate` och `fitCalibration` i `lib/cs2/pickem.ts`**

`calibrate(p, k)` är `σ(k · logit(p))`. `fitCalibration` minimerar kvadratsumman över `k` med ett rutnät 0,2–2,0 i steg om 0,01 följt av en förfining i steg om 0,001 runt bästa punkten. Färre än 4 punkter ger `{ k: 1, n: points.length, warning: "För få marknadspriser för kalibrering — kör okalibrerat." }`.

- [ ] **Step 8: Kör hela testfilen och se att den passerar**

Run: `npx vitest run tests/cs2Pickem.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/cs2/pickem.ts tests/cs2Pickem.test.ts
git commit -m "CS2: marknadskalibrering av pick'em-modellen"
```

---

### Task 4: Skriptet — modell, Kambi och utskrift

**Files:**
- Create: `scripts/cs2/pickem-2026-11-24.ts`
- Modify: `package.json` — lägg `"cs2:pickem": "tsx scripts/cs2/pickem-2026-11-24.ts"` bland skripten

**Interfaces:**
- Consumes: allt från Task 1–3; `globalModel` från `lib/cs2/matchup.ts`; `vetoProfile`, `vetoDistribution`, `seriesProbs` från `lib/cs2/veto.ts`; `mapDistribution` och `DEFAULT_SIGMA` från `lib/cs2/mapModel.ts`; `roundWinProb`, `pistolWinProb`, `matchSpread` från `lib/cs2/ratings.ts`; `activeMapPool` från `lib/cs2/maps.ts`; `fetchCs2Events`, `fetchBetOffers`, `findKambiEvent` från `lib/cs2/kambi.ts`; `cs2Prisma` från `lib/cs2Db.ts`.
- Produces: inget — skriptet är en ändpunkt.

- [ ] **Step 1: Hämta de 16 lagen och rond 1-lottningen ur databasen**

Matcherna är `Cs2Match` där `eventName` innehåller `"Major Singapore 2026 Stage 1"`. Avbryt med ett tydligt fel om det inte är exakt 8 matcher och 16 distinkta lag. Seed: lagen som står som `team1` i lottningen får seed 1–8 sorterade på `rank` (null sist), motståndarna seed 9–16 på samma sätt.

- [ ] **Step 2: Bygg sannolikhetsmatrisen ur modellen**

Följ receptet i `lib/cs2/matchup.ts:207-275`: `globalModel(cs2Prisma)` en gång; kartpoolen ur `activeMapPool` på 3 månaders veton med samma fallback som `loadMatchupContext` har när poolen blir mindre än 7 kartor; vetohistoriken för de 16 lagen ur `Cs2Veto` på 6 månader, en gång. Sedan per par och format: `vetoProfile` per lag → `vetoDistribution(format, pool, p1, p2, 0.5)` → `mapDistribution` per karta i poolen med `roundWinProb`/`pistolWinProb` och `matchSpread` → `seriesProbs(format, veto, (map) => dists[map].pAWin)`. Resultatet är en uppslagning `pModel(a, b, format)`.

- [ ] **Step 3: Verifiera matrisen innan den används**

Avbryt med fel om `pModel(a, b, f) + pModel(b, a, f)` avviker mer än 0,01 från 1 för något par och format. Skriv ut hela matrisen när skriptet körs med `--dump-matrix`.

- [ ] **Step 4: Hämta Kambis `Match Odds` för de åtta matcherna och fitta k**

`fetchCs2Events()` → `findKambiEvent` per match → `fetchBetOffers(event.id)` → den betoffer vars `criterion.englishLabel` är `"Match Odds"`. Oddsen ligger i tusendelar, så dela med 1000. Utfallens ordning följer inte vår `team1`/`team2`, så para på `participant` eller `label` mot lagnamnen och hoppa över matchen om något utfall inte går att para. `devigLogit` per match → punkter `{ pModel: pModel(a, b, "bo1"), pMarket: pA }` → `fitCalibration`. Skriv ut modell, marknad och differens per match, plus k, antal punkter och eventuell varning.

- [ ] **Step 5: Simulera och optimera**

Lägg `calibrate(p, k)` runt varje uppslagning i matrisen. 200 000 simuleringar med `simulateSwiss`, sedan `tally` och `optimizePicks(table, 5, rng)`. Använd en seedad rng och skriv ut seeden så körningen går att upprepa.

- [ ] **Step 6: Skriv ut resultatet**

Fyra block i den här ordningen:
1. Kalibreringen: k, antal punkter, och modell mot marknad per rond 1-match.
2. Utfallstabellen: ett lag per rad, sorterad på P(avancerar) fallande, med P(3-0), P(3-1/3-2), P(avancerar totalt) och P(0-3). Siffror, inte prosa.
3. De tio valen, grupperade per slot, med lagets marginalsannolikhet bakom varje namn.
4. P(≥5 rätt) och förväntat antal rätt för de valda, och samma två tal för `greedyPicks` som jämförelse.

- [ ] **Step 7: Känslighetskörning**

Flaggorna `--all-bo1` och `--all-bo3` tvingar formatet för alla matcher och kör om allt. Skriv ut de tio valen och P(≥5) för båda, så det syns om formatantagandet bär valen.

- [ ] **Step 8: Kör skriptet på riktigt**

Run: `npm run cs2:pickem`
Expected: Alla fyra block skrivs ut, k ligger mellan 0,3 och 1,5, summan av P(avancerar) över alla lag är 8,0 ± 0,05, och ingen varning om för få marknadspriser.

- [ ] **Step 9: Commit**

```bash
git add scripts/cs2/pickem-2026-11-24.ts package.json
git commit -m "CS2: skript som ger pick'em-valen för Major Stage 1"
```
