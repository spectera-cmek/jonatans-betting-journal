# Morgonrutin: rätta gårdagens bets och mejla rapport

Körs som schemalagd Claude-uppgift ca 08:00 Europe/Stockholm, i **huvud-checkouten**
`C:\Users\ompam\Documents\Betting Tracker` (INTE i en worktree).

## Säkerhetsregler (får aldrig brytas)

- Rätta ENDAST säkra matchnivå-resultat: 1X2/matchvinnare (`market: h2h`),
  över/under mål (`totals`), handikapp (`spreads`) — med `marketScope` match eller
  team, ALDRIG `player`.
- Spelarprops (`marketScope: player` eller otydliga `market: other`) lämnas ALLTID
  pending — lista dem i rapporten med anledning.
- Accumulators rättas bara om ALLA ben är säkra matchnivå-resultat och avgjorda;
  annars pending.
- Matchen MÅSTE vara färdigspelad (inkl. förlängning/straffar) innan du rättar:
  - Har spelet ett `eventAt`: rätta bara om det ligger minst 3 timmar bakåt i tiden.
  - Saknar spelet `eventAt` (vanligt — kvitto-skärmdumpar har ofta ingen matchtid):
    exkludera det INTE per automatik. Sök upp matchen på lagnamnen/spelarna och
    rätta om — och bara om — webben bekräftar att matchen är slutspelad med ett
    entydigt resultat. Kan du inte bekräfta att den är över → pending.
- Varje rättning kräver en tydlig webbkälla (officiell liga, ESPN, Flashscore, HLTV,
  Sofascore e.d.). Slutresultat + källa skrivs i `reason`. Hittas ingen entydig
  källa, eller är matchen inte färdigspelad → pending.
- Futures/outright/"specialspel" (t.ex. "att nå finalen", "vinnare av grupp",
  "i semifinal") avgörs först när turneringen/gruppen är klar — rätta bara om
  utfallet är definitivt avgjort, annars pending.
- Obs: "UTE ur turneringen" på straffar räknas som förlust för "vidare"-spel men
  matchresultatspel efter 90 min kan vara oavgjort — läs marknaden noga.
- Kör ALLTID `--dry-run` först och granska utskriften före skarp körning.
- Rör aldrig bets som inte är pending (skriptet skyddar också mot detta).
- Bets med odds 1.01 är import-placeholders, inte riktiga odds — rättas som vanligt
  på utfall, men lita inte på oddset för resonemang.

## Steg

1. Lista öppna bets:
   ```
   npx tsx scripts/agent/openBets.ts > .claude/tmp/open-bets.json
   ```
2. Dela upp i (a) säkra kandidater enligt reglerna ovan och (b) lämnas pending.
3. Webbresearch per kandidat: slutresultat + källa. Osäkert/ej hittat → flytta till (b).
4. Skriv `.claude/tmp/results-YYYY-MM-DD.json`:
   ```json
   [
     { "id": "<betId>", "outcome": "win|loss|push|void|half_win|half_loss",
       "reason": "CIN 4-2 PHI (källa: MLB.com box score)" }
   ]
   ```
5. Dry-run och granska att rätt bets träffas:
   ```
   npx tsx scripts/agent/settleBets.ts --file .claude/tmp/results-YYYY-MM-DD.json --dry-run
   ```
6. Skarp körning (skriptet backar först upp raderna till `.claude/backups/`):
   ```
   npx tsx scripts/agent/settleBets.ts --file .claude/tmp/results-YYYY-MM-DD.json
   ```
7. Skriv rapporten till `.claude/tmp/report-YYYY-MM-DD.txt` (svenska, ren text):
   - Rättade bets: event — selection @ odds → utfall, ±units (±kr à 100 kr/unit)
   - Netto totalt i units och kr
   - Kvar öppna: event — selection + varför (spelarprop / ej färdigspelad / ingen källa)
   - Inga öppna bets alls → kort rapport "Inga öppna bets i morse."
8. Mejla rapporten:
   ```
   npx tsx scripts/agent/sendReport.ts --subject "Bettingjournal – rättning YYYY-MM-DD" --body-file .claude/tmp/report-YYYY-MM-DD.txt
   ```
9. Om något steg misslyckas: skicka ÄNDÅ ett mejl med felbeskrivningen i stället
   för att tyst avbryta (t.ex. `--subject "Bettingjournal – rättning misslyckades"`).

## Tidszon

Alla datum/tider i rapporten avser Europe/Stockholm. `eventAt` i databasen är UTC.
