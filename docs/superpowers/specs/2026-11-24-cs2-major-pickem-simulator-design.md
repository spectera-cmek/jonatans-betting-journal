# Pick'em-simulator för PGL Major Singapore 2026, Stage 1

Datum: 2026-11-24. Kort design (engångsskript, inte en appyta).

## Varför

Jonatan vill ha Diamond-myntet i Majorns Pick'Em Challenge. Utmaningen som
avgör det för Stage 1 är **minst 5 av 10 rätt**. Valen ska komma ur en
simulering, inte ur magkänsla. Picks låser 2026-11-24 kl 04:00 UTC
(05:00 svensk tid), när första matchen börjar.

Pick'em-etappen består av tio val: **2 lag på 3-0**, **6 lag som avancerar på
3-1 eller 3-2**, **2 lag på 0-3**. Ett lag lagt på 3-0 som i stället går 3-1
räknas som fel.

## Mål

- Tio val som maximerar **P(≥5 rätt)** — inte förväntat antal rätt.
- Utfallstabell per lag (P(3-0), P(avancerar), P(0-3)) så valen går att
  granska, inte bara lita på.
- Klart i god tid före kl 04:00 UTC.

## Icke-mål

- Ingen sida i appen, inget API, inget som deployas.
- Ingen edge mot bookmaker — detta är inte ett spel, bara val.
- Inte Stage 2 eller slutspelet. De picksen öppnar senare och får en egen körning.

## Anti-mål

Det här vore misslyckat även om skriptet kör:

- Val som ser smarta ut men sänker P(≥5) — till exempel två långskott på 3-0.
- Tysta fel i formatet. Fel bo1/bo3 flyttar skrällfrekvensen och därmed valen.
- Att lita på `Cs2Match.format` utan att kontrollera det (se nedan).

## Förutsättningar och begränsningar

- **Format.** `Cs2Match.format` säger `bo3` för alla åtta rond-1-matcher. Det
  är fel: Kambis utbud på matcherna är enkartsmarknader rakt igenom (First to
  12 Rounds, Total Rounds, overtime, pistolrundor) och saknar karthandikapp,
  och "Match Odds" 1.47 ligger på samma nivå som "First to 12 Rounds" 1.46.
  Rond 1 är bo1. Valves regel kodas i stället direkt: **bo1 överallt utom
  matcher som avgör avancering eller elimination**, det vill säga lag på 2-0,
  2-1 och 2-2 (avancering) och 0-2, 1-2 och 2-2 (elimination). Alltså bo1 i
  rond 1–2 och i 1-1-gruppen i rond 3; bo3 i resten.
- **Datatäckning.** Alla 16 lag har 57–149 kartor senaste 180 dagarna,
  rundhistorik på alla 7 375 kartor i databasen och 19 178 veto-rader.
- **Modellen slår inte Unibet.** Det är fastställt 2026-11-23. Därför
  kalibreras modellen mot marknaden i stället för att köras rå.
- CS2-databasen nås lokalt via `CS2_DATABASE_URL`.

## Vägar som övervägdes

1. **Enbart den egna CS2-modellen.** `globalModel()` → vetoprofil →
   `mapDistribution` → `seriesProbs`. Fångar kartnivå och veto, men är
   okalibrerad mot marknaden.
2. **Enkel styrkerating ur rank.** Snabbt och trubbigt, slänger bort kartnivån
   och vetot. **Förkastad** — modellen finns redan och är bättre.
3. **Enbart marknadsodds.** Mest rätt för rond 1, men det finns inga priser på
   hypotetiska möten i rond 2–5. **Förkastad som grund**, behålls som kalibrering.

**Valt: 1 + 3.** Modellen är motorn, marknaden drar skalan. Jonatan valde detta.

## Design

### 1. Sannolikhetsmotor

Receptet i `loadMatchupContext` (lib/cs2/matchup.ts:207–275) lyfts ut till en
funktion som tar två lag-id och ett format i stället för ett matchId:
`globalModel()` en gång, kartpool och vetohistorik en gång, sedan per par
`vetoProfile` → `vetoDistribution` → `mapDistribution` per karta →
`seriesProbs`. Ger `pWin(A, B, format)` för alla 120 par i både bo1 och bo3.
Ingen ändring i befintliga filer; den nya koden bor i skriptet.

### 2. Marknadskalibrering

Hämta `Match Odds` från Kambi för de åtta rond-1-eventen, avvigga, och fitta
**en** global skalfaktor k på log-odds så modellen möter marknaden:
`p_kal = σ(k · logit(p_modell))`. k < 1 betyder att modellen är för tvärsäker.
k fittas på de åtta matcherna och appliceras på alla par. Skriptet skriver ut k
och modell mot marknad per match, så en orimlig k syns direkt.

Avviggning sker additivt på log-odds, inte multiplikativt: multiplikativ
de-vig smickrar höga odds, vilket är dokumenterat i den här kodbasen.

### 3. Swiss-simulering

Rond 1 har känd lottning. Rond 2–5: lag grupperas på facit, buchholz avgör
parning, omatcher undviks, seed skiljer lika buchholz. Topp 8 avancerar.
200 000 simuleringar.

### 4. Optimerare

Per simulering noteras varje lags utfall (3-0, avancerar med 1–2 förluster,
0-3). För en kandidatuppsättning räknas antal rätt per simulering → P(≥5).
Sökningen startar från det giriga EV-valet och klättrar lokalt; de bästa
uppsättningarna skrivs ut med både P(≥5) och förväntat antal rätt, så valet
går att se i båda måtten.

### 5. Utdata

Utfallstabell per lag, de tio valen, P(≥5), samt en känslighetskörning med
allt-bo1 och allt-bo3 så det syns om formatantagandet bär valen.

## Mina beslut, inte Jonatans

- **Seedning.** Rond 1-lottningen avslöjar topphalvan (HEROIC, 9z, 100T, NiP,
  Liquid, PARIVISION, FaZe, Eternal Fire mot de övriga åtta). Den inre
  ordningen approximeras med HLTV-rank. Påverkar bara buchholz-skiljningar.
- **3-0-val räknas bara som 3-0**, aldrig som ett avancerings-val. Källan säger
  inte vad Valve gör; det här är den strikta tolkningen och den säkra.
- 200 000 simuleringar; additiv de-vig; en global k snarare än en per lag.

## Lämnat till byggaren

Detaljerna i den lokala sökningen och exakt utskriftsformat.
