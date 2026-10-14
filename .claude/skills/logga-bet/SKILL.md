---
name: logga-bet
description: >-
  Logga bets i trackern från spelkvitto-skärmdumpar (Paf, HappyCasino, LuckyCasino,
  SpeedyBet, veraochjohn, Coolbet, Smarkets, NordicBet, Bet365, Betsson m.fl.). Läser
  kvittot, mappar till rätt marknad/scope/sida/bookmaker enligt loggens egna
  konventioner och skriver till databasen. Använd när användaren klistrar in ett
  spelkvitto eller ber om att logga, föra in eller rätta en bet.
---

# Logga bet från kvitto

Målet: från en kvitto-skärmdump till en rad i `Bet`-tabellen med så få tokens och
så lite gissande som möjligt. Konventionerna nedan är redan uträknade — följ dem,
fråga inte databasen om hur du brukar tagga en marknad.

## Snabbaste vägen (noll Claude-tokens)
Är `ANTHROPIC_API_KEY` satt i appen (Vercel → Environment Variables) gör knappen
**Från kvitto** på Bets-sidan hela jobbet på Haiku (~5 öre/bild). Föreslå den för
bulk. Det här skillet är för när loggningen ändå sker i chatten.

## Arbetsflöde
1. Läs skärmdumpen. Extrahera fälten enligt tabellen nedan. **Gissa aldrig** odds,
   insats eller bookmaker — oläsbart fält blir tomt/utelämnat.
2. Bygg en JSON-array (ett objekt per bet) och kör allt i **ett** kommando:
   ```bash
   npx tsx scripts/agent/logBetHttp.ts --stdin <<'JSON'
   [ { ...bet1... }, { ...bet2... } ]
   JSON
   ```
   Lägg till `--dry` först om du vill se den byggda raden utan att skriva.
3. Rapportera kort: event — selection @ odds | Xu | bookmaker | liga, per bet.

Skriptet: slår upp `unitValue` (kr→units), kör `buildBetData` (samma validering,
marknadsnormalisering och sport/sida-inferens som appen), hoppar över dubbletter
på `importRef` (annars event+selection+odds inom 2 dygn), och sätter ett cuid-id.
Rör aldrig redan loggade rader.

**Molnsession:** skriptet går via Neons HTTP-endpoint (port 5432 är blockad).
Det kräver den riktiga `DATABASE_URL` — den i containern är en maskerad
platshållare (innehåller `…`). Be användaren om strängen eller sätt den i
miljökonfigurationen; kör sedan `DATABASE_URL='postgres://…' npx tsx …`.

## Fält per bet (JSON)
Kärnfält: `event` ("Hemma vs Borta"), `homeTeam`, `awayTeam`, `sport`, `league`,
`selection`, `odds` (decimal), `stakeKr`, `bookmaker`, `importRef`, `placedAt`
(ISO), `eventAt` (ISO, med klockslag om det syns), `outcome` (default `pending`;
`loss`/`win`/`push`/`void` när användaren säger resultat), `betType`, `notes`.
Fulla listan: `lib/betInput.ts` (BetInput). Insats i kr → skriptet räknar units.

### Marknad → market / marketCategory / marketScope / selectionSide
| Vad kvittot visar | market | marketCategory | scope | side / line |
|---|---|---|---|---|
| Matchvinnare / 1X2 | `h2h` | Matchvinnare | match | home/away/draw |
| Spelarprop (namngiven spelare: skott, kills, poäng, mål…) | `other` | t.ex. Skott på mål / Kills | player | over/under + line |
| Lag-total (skott/hörnor/kort/offside för **ett** lag) | `totals` | Skott/Hörnor/Kort & fouls/Offside | team | over/under + line |
| Match-total (mål/skott i hela matchen) | `totals` | Totalt / Skott på mål | match | over/under + line |
| BTTS (båda lagen gör mål) | `other` | BTTS | match | — |
| 3-vägshandicap "startar X-Y" (inget linjetal) | `other` | Handikapp | match | sida = laget du tog |
| Målband "4-5", "Antal mål 4-5" | `other` | Totalt | match | — (rättas för hand) |
| Samma-match-kombo (Bygg bet / flera val, ett odds) | `other` | Kombination | match | `betType: betbuilder` + `legs[]` |
| Kombo över flera matcher | `other` | Kombination | match | `betType: accumulator` + `legs[]` |

- `other` = avräknas för hand (props, betbuilder, 3-vägshandicap, målband). Använd
  **inte** `spreads` för 3-vägshandicap — appens spreads-rättning skulle läsa
  oavgjort-efter-handicap som push i stället för förlust.
- Börskvitto (Smarkets): **PRIS** = odds, **INSATS** = insats; MATCHAT och V&F är
  ingetdera. SIDA BUY = vanligt spel; SIDA SELL = lay → inled selection med "Lay: ".

## Bookmaker — läs loggan, gissa aldrig
Fel bookmaker ger fel stängningsodds vid CLV. `normalizeBookmaker` kanoniserar
stavning; ditt jobb är att läsa rätt varumärke.

- **Plattformskvitton — SAMMA mall, olika bolag:** Paf, HappyCasino, LuckyCasino,
  SpeedyBet, veraochjohn kör alla "Ditt spel har lagts!", "Kvitto #" + ~11 siffror
  (börjar 130…), gul CASH OUT, kryssruta längst ner. **Varken mallen, numret
  eller kryssrutans text avgör bolaget — bara loggan.** Paf = vit/grön, "Återanvänd
  val". HappyCasino = lila, "happy" i regnbågsgemener. Syns ingen logga → **fråga
  användaren** (AskUserQuestion), sätt inte ett namn.
- **Coolbet:** "Kupong ID N" → `importRef: "coolbet-#N"`. Grön/färgglad logga.
- **Smarkets:** svart börs-app, MATCHAT/OMATCHAT, SIDA/INSATS/PRIS, HANDEL.
- **18-siffrigt "Spel ID":** NordicBet (vanligast), Betsson eller Bethard — fråga
  om loggan inte syns.
- **Bet365:** grön header, "Spel placerat", ref "XP…".
- Bookmaker som inte finns i `BOOKMAKERS` (lib/constants.ts): skriv namnet som det
  står, så syns det ändå. Fler utseende-ledtrådar: `lib/betslipExtract.ts`.

## Datering
- `eventAt` = avspark **med klockslag** när kupongen visar det (Coolbet-kort:
  "26 aug 21:00"). Kickoff-CLV behöver tiden.
- Kvitto-skärmdumpar visar oftast bara läggningstid, inte avspark → `eventAt` =
  bara datum, eller fråga. `placedAt` = kvittots tidsstämpel.
- Nordamerika/Sydamerika-kväll (MLS, Liga MX, Brasilien) = ofta **nästa dygn**
  svensk tid. Kolla mot kupongens tid innan du daterar.

## Vad du avgör själv vs frågar om
- Avgör: marknadsmappning, sida, units-omräkning, datum från kupongtid.
- Fråga (AskUserQuestion): bookmaker när loggan inte syns; liga när kvittot inte
  visar den och du inte har en tidigare bet på laget att härma; resultat vid rättning.
- Flagga (utan att fråga): ovanligt stor insats jämfört med normala 1–1.5U.

## Rätta öppna bets
Uppdatera `outcome` (+ `profitUnits` = `stakeUnits*(odds-1)` vid win, `-stakeUnits`
vid loss, `null`/0 vid push/void) med en `UPDATE` via samma HTTP-väg, eller
`scripts/agent/settleBets.ts` när Prisma når databasen.

## Modell
Med det här skillet är loggningen mekanisk — kör gärna sessionen på en billigare
modell (`/model claude-haiku-4-5` eller `claude-sonnet-5`). All bedömning som
kräver omdöme står ovan; det som återstår är avläsning + ifyllnad.
