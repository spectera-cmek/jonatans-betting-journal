# Rätta öppna bets (max coverage + multi-källa)

Schemalagd eller manuell agent-rutin. Körs mot Neon Postgres via `DATABASE_URL`
(sätts i `.env` / Cloud Agent secrets). Målet: **rätta så många avgjorda bets som
möjligt** utan att gissa — prova flera källor tills resultatet är entydigt.

## Säkerhetsregler (får aldrig brytas)

- Rätta **bara** när utfallet är **definitivt avgjort** och bekräftat av minst en
  trovärdig källa. Osäkert → lämna pending och förklara varför.
- Matchnivå (`h2h` / `totals` / `spreads`, `marketScope` match/team): rätta när
  matchen är färdig och slutresultatet är klart.
- Spelarprops (`marketScope: player` eller `market: other` med spelarstatistik):
  rätta **bara** om box score / officiell spelarstatistik bekräftar raden
  (t.ex. skott, baser, poäng, mål). Annars pending.
- Accumulators: rätta bara om **alla** ben är avgjorda och säkert graderade;
  annars pending (lista vilka ben som saknas).
- Futures/outright/"specialspel" (grupp, vidare, finalist, turneringsvinnare):
  rätta bara när turneringen/gruppen gör utfallet definitivt. "UTE" på vidare =
  loss; 90-minuters-marknader ≠ slut efter straffar — läs marknaden noga.
- Matchen måste vara färdig (inkl. förlängning/straffar om marknaden gäller det):
  - Har betet `eventAt`: rätta bara om start var minst ~3 h sedan **eller**
    webben bekräftar att matchen är slut.
  - Saknar `eventAt`: sök upp matchen på lag/spelare och rätta bara om webben
    bekräftar slutresultat. Annars pending.
- Varje rättning ska ha **källa i `reason`** (slutresultat + källa).
- Kör **alltid** `--dry-run` först, granska, sedan skarp körning.
- Rör aldrig redan rättade bets (skriptet skyddar också).
- Odds `1.01` = import-placeholder — rätta på utfall, lita inte på oddset.

## Källprioritet (prova i ordning tills entydigt)

Gör **allt rimligt** innan du ger upp. Byt källa om första missar, är paywall,
motsäger sig själv, eller saknar den marknad du behöver.

### 1) Appens egna hjälpmedel (först)

- Lista öppna: `npx tsx scripts/agent/openBets.ts > .claude/tmp/open-bets.json`
- För strukturerade singlar (h2h/totals/spreads) med känd liga: ESPN via appens
  sync/grading (`lib/scores.ts`, `lib/gradingQueue.ts`) är bra första pass —
  men **verifiera** resultatet innan du skriver till settle-filen. Använd inte
  ESPN-förslag blint om lagmatchningen känns fel.

### 2) Webb / officiella källor (per sport)

| Sport / typ | Primär | Fallback |
|---|---|---|
| Fotboll (toppligor, VM) | ESPN, Sofascore, Flashscore | Officiell liga (premierleague.com, …), BBC Sport |
| NBA / WNBA | ESPN, NBA.com box score | Basketball-Reference, Sofascore |
| NHL | ESPN, NHL.com | Natural Stat Trick / Hockey-Reference (props) |
| MLB | MLB.com box score, ESPN | Baseball-Reference |
| NFL / college | ESPN, NFL.com | Pro-Football-Reference |
| Tennis | ATP/WTA / ITF, Flashscore | Sofascore, ESPN |
| UFC / MMA | UFC.com, ESPN | Tapology |
| Esport (CS) | HLTV | Liquipedia |
| Övrigt / obskyr liga | Flashscore / Sofascore | Google `"Lag A" "Lag B" score"` + officiell källa |

### 3) Spelarprops — extra krav

- Hitta **box score** eller officiell spelarstatistik för just den matchen.
- Räkna raden exakt mot `selection` / `line` / `marketCategory` (t.ex. "Över 1.5
  skott", "2+ baser").
- Om statistiken är ofullständig, preliminär, eller tvetydig → pending.
- Preferera officiell liga-site framför odds-sajter.

### 4) När källor krockar

- Lita på officiell liga / box score före aggregators.
- Om två trovärdiga källor fortfarande skiljer sig → **pending** + notera konflikten.
- Gissa aldrig.

## Steg

1. Lista öppna bets:
   ```
   npx tsx scripts/agent/openBets.ts > .claude/tmp/open-bets.json
   ```
2. Dela upp i:
   - **(A) kandidater** — match/event verkar avgjort eller kan verifieras nu
   - **(B) vänta** — framtida `eventAt`, live, futures ej klara
   - **(C) manuell** — otydlig marknad, saknad data, konflikter
3. Research per kandidat med källprioriteten ovan. Spara slutresultat + URL/namn
   på källan. Misslyckad första källa → prova fallback innan (C).
4. Skriv `.claude/tmp/results-YYYY-MM-DD.json`:
   ```json
   [
     {
       "id": "<betId>",
       "outcome": "win|loss|push|void|half_win|half_loss",
       "reason": "CIN 4-2 PHI; Bleday 2 baser (MLB.com box score)"
     }
   ]
   ```
5. Dry-run:
   ```
   npx tsx scripts/agent/settleBets.ts --file .claude/tmp/results-YYYY-MM-DD.json --dry-run
   ```
6. Skarp körning (backup till `.claude/backups/`):
   ```
   npx tsx scripts/agent/settleBets.ts --file .claude/tmp/results-YYYY-MM-DD.json
   ```
7. Rapport `.claude/tmp/report-YYYY-MM-DD.txt` (svenska):
   - Rättade: event — selection @ odds → utfall, ±units (±kr à 100 kr/unit)
   - Netto totalt
   - Kvar öppna med **orsak** (ej färdig / prop saknar box score / konflikt / future)
   - Inga öppna → "Inga öppna bets."
8. Mejla (om rutinens secrets finns):
   ```
   npx tsx scripts/agent/sendReport.ts --subject "Bettingjournal – rättning YYYY-MM-DD" --body-file .claude/tmp/report-YYYY-MM-DD.txt
   ```
9. Misslyckas ett steg: skicka ändå mejl/rapport med felbeskrivning — tyst avbrott
   är inte okej.

## Outcome-guide (kort)

| Situation | outcome |
|---|---|
| Vinst | `win` |
| Förlust | `loss` |
| Insatsen tillbaka (exakt totals-line, voidad marknad) | `push` / `void` |
| Asiatisk halv | `half_win` / `half_loss` |

Profit beräknas av `settleBets.ts` via `lib/betting.ts` — ange bara outcome + reason.

## Tidszon

Rapporttider: Europe/Stockholm. `eventAt` i DB lagras i UTC.

## Secrets (Cloud Agent / lokal)

Krävs för skarp körning:

- `DATABASE_URL` (+ `DIRECT_URL` vid behov)
- För mejl: `GMAIL_USER`, `GMAIL_APP_PASSWORD` (valfritt `GMAIL_TO`)

Sätt dem i Cloud Agents dashboard om automationen kör i molnet.
