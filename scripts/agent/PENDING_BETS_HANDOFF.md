# Pending bets — att logga när DATABASE_URL fungerar igen

Skapad: 2026-10-14. Databasen (`DATABASE_URL`) var maskerad/trasig i den föregående
sessionens container trots att secreten sattes om i miljöns Network secrets — ändringen
verkar bara plockas upp av en **ny** session/container. Såhär testar du om det funkar:

```
cd /home/user/jonatans-betting-journal
echo '[]' | npx tsx scripts/agent/logBetHttp.ts --stdin --dry
```

Om det INTE säger `DATABASE_URL är en maskerad platshållare` längre — kör vidare och logga
allt nedan via `scripts/agent/logBetHttp.ts --stdin`, exakt som vanligt (se skript-headern
för format). Ta bort den här filen (och committa borttagningen) när allt är loggat.

**Innan du loggar:** slå upp redan etablerade `eventAt`-värden i `Bet`-tabellen för
matcher som redan loggats tidigare i sessionen (Champions League matchday 2-matcherna
nedan har med stor sannolikhet redan loggats via andra bets samma kväll) — matcha på
lagnamn, återanvänd exakt samma `eventAt` istället för att räkna om det.

## Öppna frågor till användaren (fråga INNAN du gissar)

1. **Bet #1** (Expekt 5-kombination BTTS): insats var beskuren i skärmdumpen. Beräknat
   ≈104,21 kr från utbetalning/odds (1017,08 / 9.76), men bekräfta med användaren innan
   du loggar — runda inte på egen hand.
2. **Bet #2** (Expekt Trippel skott-boost): insats OCH utbetalning syntes inte alls på
   skärmdumpen. Måste få detta från användaren, kan inte beräknas.
3. **Bets #6–11** (de 6 "Betsson"-gissade kvittona): bookmaker är INTE bekräftad. Två
   olika visuella teman sågs (ljust lila "SPEL LAGT" vs mörkt "Ditt spel har lagts!"
   med röd/grön Stäng-knapp), båda med "Kvitto #:"-numrering i stora sekventiella
   nummer (13223686835 osv) — skiljer sig från Coolbets "Kupong ID"-format i bets
   #12–14 nedan, så det är sannolikt EN bookmaker men inte Coolbet och inte bekräftat
   som Betsson. Fråga användaren innan loggning. OBS: ingen av dessa är faktiskt
   cashad ut — "CASH OUT"-badgen visar bara att funktionen finns tillgänglig, det är
   fortfarande öppna/pågående bets.

## Bets att logga (15 st, kronologisk ordning)

### Batch A — Expekt, placerade 2026-10-13

**1. Expekt — 5-kombination (boost 8.13→9.76), BTTS "Ja" x5**
- Payout 1017,08 kr → insats ≈104,21 kr (BEKRÄFTA, se ovan)
- Champions League matchday 2, alla "Båda lagen gör mål: Ja":
  - Galatasaray SK - FC Barcelona @1.44
  - Inter Milano - Club Brugge @1.67
  - RB Leipzig - PSV Eindhoven @1.33
  - Viking - Bayern München @1.62
  - Villarreal CF - SSC Napoli @1.57
- eventAt: återanvänd etablerade CL MD2-tider för respektive match (redan loggade
  tidigare i sessionen under andra bets — slå upp i DB).
- notes: boostad kombination, odds boostades 8.13→9.76.

**2. Expekt — Trippel (boost 3.71→4.46), spelare skott**
- Insats/utbetalning okänd — FRÅGA ANVÄNDAREN (se ovan)
- Champions League matchday 2:
  - Yamal, Lamine 2+ skott på mål (Galatasaray SK - FC Barcelona) @1.50
  - Martinez, Lautaro 2+ skott på mål (Inter Milano - Club Brugge) @1.62
  - Olise, Michael 2+ skott på mål (Viking - Bayern München) @1.53
- eventAt: samma matcher/tider som bet #1.
- notes: boostad trippel, odds boostades 3.71→4.46.

**3. Expekt — AL Ahli (Qat) - AL Gharafa, QBL Basket**
- Handicap: AL Gharafa +5.5 @1.83
- Insats 300 kr, payout 549 kr
- eventAt: 2026-10-13T15:00:00Z (Idag 17:00 CEST)
- sport: Basket, league: Qatari Basketball League (QBL)

**4. Expekt — Ottawa Senators - St. Louis Blues (NHL)**
- Stephen Halliday 3+ skott på mål @2.18
- Insats 180 kr, payout 392,40 kr
- eventAt: 2026-10-13T23:30:00Z (Imorgon 01:30 CEST = 2026-10-14 natt)
- sport: Ishockey, league: NHL

**5. Expekt — Sabah (Baku) - SK Slavia Praha, Champions League**
- SK Slavia Praha skott: Över 15.5 @2.00
- Insats 280 kr, payout 560 kr
- eventAt: 2026-10-13T16:45:00Z (bekräftat via sök: 2026-10-13 18:45 CEST)

### Batch B — bookmaker OBEKRÄFTAD (se fråga #3 ovan), placerade 2026-10-14 ca 08:50–11:30

**6. Feyenoord - Como, Champions League**
- Totalt antal skott: Över 30.5 @1.92
- Insats 220 kr, payout 422,40 kr
- eventAt: 2026-10-14T16:45:00Z (Ikväll 18:45 CEST)

**7. Man City - PSG, Champions League**
- Nuno Mendes skott på mål: Över 0.5 @3.30
- Insats 146 kr, payout 481,80 kr
- eventAt: 2026-10-14T19:00:00Z (21:00 CEST, bekräftat via Coolbet-kvitto #12 nedan)

**8. Man City - PSG, Champions League**
- PSG matchvinnare (Fulltid) @3.30
- Insats 120 kr, payout 396 kr
- eventAt: samma som #7. Status: öppen/pågående (ej cashad ut, se fråga #3).

**9. Feyenoord - Como, Champions League**
- Nacho skott på mål: Över 1.5 @3.10
- Insats 120 kr, payout 372 kr
- eventAt: samma som #6.

**10. Real Betis - FC Porto**
- Isco skott på mål: Över 0.5 @2.02
- Insats 200 kr, payout 404 kr
- eventAt: okänd, inte angiven på kvittot — fråga användaren eller sök upp.

**11. Trippel (cashout-möjlighet, ej cashad ut) — spelare skott, 3 ben**
- Totalodds 2.90, insats 120 kr, payout 347,91 kr
- Nacho Över 0.5 skott (Feyenoord - Como) @1.45 — eventAt som #6
- Andreas Helmersen Över 0.5 skott (Bodø/Glimt - Borussia Dortmund) @1.29 — Champions League, eventAt okänd, sök upp
- Vedat Muriqi Över 0.5 skott (Aston Villa - Fenerbahçe) @1.55 — eventAt okänd, sök upp

### Batch C — Coolbet + Expekt, placerade 2026-10-14 ca 12:29–13:00

**12. Coolbet — Kombo [5] #598**
- Totalodds 15.92, insats 120 kr, payout 1910,09 kr
- Champions League matchday 2:
  - Feyenoord - Como: Como antal mål Över 1.5 @1.75 (14 okt 18:45 CEST → eventAt 2026-10-14T16:45:00Z)
  - LASK Linz - Liverpool: Antal hörnor Under 10 @1.88 (14 okt 18:45 CEST → 2026-10-14T16:45:00Z)
  - Slovan Bratislava - VfB Stuttgart: Antal hörnor Över 9.5 @1.81 (14 okt 21:00 CEST → 2026-10-14T19:00:00Z)
  - Manchester City - Paris Saint-Germain: BTTS & Över 2.5 mål, Ja @1.65 (14 okt 21:00 CEST → 2026-10-14T19:00:00Z)
  - AS Roma - Real Madrid: Real Madrid antal hörnor Under 5.5 @1.62 (14 okt 21:00 CEST → 2026-10-14T19:00:00Z)
- importRef-källa: Kupong #598

**13. Coolbet — Thunderpick World Championship 2026 (CS2), Kupong #596**
- Legacy - PARIVISION, Map 2 — Duel of Player Kills Draw No Bet (Hobbit vs n1ssim) → n1ssim @1.65
- Insats 300 kr, payout 495 kr
- eventAt: samma match som #14 (2026-10-14T13:30:00Z) — bekräfta om Map 2 har annan starttid.

**14. Coolbet — Thunderpick World Championship 2026 (CS2), Kupong #597**
- Legacy - PARIVISION, Map 1 — Duel of Player Kills Draw No Bet (Hobbit vs n1ssim) → n1ssim @1.72
- Insats 300 kr, payout 516 kr
- eventAt: 2026-10-14T13:30:00Z (14 okt 15:30 CEST)

**15. Expekt — SHL, IF Björklöven - Rögle BK**
- Tinus Luc Koblar gör mål: Ja — boost 4.19→5.05, dessutom individuell oddsförbättring till 4.20
- Insats 105 kr, payout 530,26 kr (ord. 441,00 kr innan boost)
- eventAt: 2026-10-15T17:00:00Z (Imorgon 19:00 CEST, placerat 2026-10-14)
- notes: boostad (4.19→5.05) + "Dina odds förbättrades under spelplaceringen" till 4.20 på selektionen.
