# Matcher alltid uppdaterade: skott, CS2 och NBA

2026-11-17 · Status: utkast, väntar på Jonatans godkännande

## Syfte

/skott, /cs2 och /nba ska alltid visa dagens och de kommande matcherna, utan att
Jonatan kör något för hand. När det inte går ska det märkas direkt i stället för
att sidorna tyst visar gammal data.

## Läget i dag

- **NBA:** fem schemalagda Windows-uppgifter (`scripts/install-nba-tasks.ps1`,
  `scripts/run-nba.cmd`). De går som de ska, men varje körning har fallerat sedan
  ungefär 9 november: Neon-projektet `neon-aureolin-school` har slagit i
  gratisplanens tak för dataöverföring (5,5 av 5 GB). Kvoten nollställs 1 december.
  `run-nba.cmd` loggar `exit=` utan kod, och Schemaläggaren visar 0, så felet
  syntes inte.
- **CS2:** `npm run cs2:update` är skriven för Schemaläggaren men har aldrig
  lagts in där. HLTV kräver en webbläsare eller Scrapling lokalt (Cloudflare).
- **Skott:** inget fyller på sedan TheStatsAPI togs bort. `shots:ingest`
  (Sofascore via Scrapling) sparar både kommande fixtures och statistik för
  spelade matcher, men körs bara för hand.
- **Molnet:** den enda Vercel-cronen är `/api/cron/grade`.
- **Neon-förbrukning i november:** CS2 och skott har använt några MB
  dataöverföring och ett par timmar beräkningstid. Det finns gott om utrymme.

## Mål

1. CS2 och skott uppdateras automatiskt varje dag, och CS2-linjerna flera
   gånger om dagen.
2. NBA kommer i gång igen 1 december, och kvoten räcker hela månaden därefter.
3. Ett fel eller en körning som uteblivit syns på sidan och kommer som en notis
   på mobilen.

## Icke-mål

- Ingen flytt till molnet. HLTV och Sofascore spärrar molnservrar, och datorn
  står på nästan jämt.
- Ingen uppgradering av Neon. Jonatan väljer att vänta till 1 december.
- Ingen automatisk hämtning av skottodds. Oddsen förs fortfarande in för hand.

## Anti-mål

- Att CS2 eller skott slår i sina Neon-kvoter, som NBA gjorde.
- Notisspam. NBA-uppgifterna får inte larma varje timme fram till 1 december.
- Webbläsarfönster som dyker upp mitt i arbetet varje dag.

## Tillvägagångssätt

| Alternativ | Avvägning | Beslut |
|---|---|---|
| **A. Allt lokalt i Windows Schemaläggare** | Fungerar med HLTV och Sofascore. Kräver att datorn står på, vilket den gör nästan jämt. | **Valt** |
| B. Hybrid: lokalt plus Vercel-cron för de rena HTTP-delarna (Kambi, ESPN, Smarkets) | Två system att hålla ordning på. Vercels gratisplan kör cron högst en gång per dygn. Ingen vinst så länge datorn står på. | Valdes bort |
| C. Claudes schemalagda uppgifter | Opålitligt för en datapipeline och dyrt per körning. | Valdes bort |

Jonatan valde A efter att ha bekräftat att datorn står på nästan jämt.

## Design

### 1. Gemensam körare: `scripts/runJob.ts`

`run-nba.cmd` ersätts av en kör-fil, `scripts/run-job.cmd <npm-skript>`, som
anropar `tsx scripts/runJob.ts <npm-skript>`. Körningen:

- startar `npm run <npm-skript>` och skriver utdata till
  `.claude/logs/<område>.log`, som i dag;
- registrerar den riktiga exit-koden och returnerar den, så att Schemaläggaren
  visar fel som fel;
- skriver en rad i huvuddatabasens `SyncLog` med `kind = "lokal:<npm-skript>"`,
  "ok" eller felets sista rad, och hur lång tid körningen tog;
- skickar en ntfy-notis (`NTFY_TOPIC`) när en körning misslyckas. Högst en
  notis per jobb och dygn, så att ett ihållande fel inte spammar.

### 2. Installationsskript: `scripts/install-tasks.ps1`

Ersätter `install-nba-tasks.ps1` (som tas bort) och installerar alla uppgifter:

| Uppgift | Kör | När | Ikapp om datorn var av |
|---|---|---|---|
| Skott | `shots:ingest -- --league all --confirm` | dagligen 09:00 | ja |
| CS2 | `cs2:update -- --scrapling --headless` | dagligen 10:00 | ja |
| CS2-linjer | `cs2:lines` | varannan timme 12–22 | nej |
| NBA ×5 | som i dag | som i dag | som i dag |

CS2 körs med Scrapling och dolt fönster, så att inget fönster dyker upp.
Demotaken (`--max-gb`) behåller skriptets försiktiga standardvärden.

### 3. NBA fram till 1 december

NBA-uppgifterna stängs av nu (`Disable-ScheduledTask`) och sätts på igen efter
1 december, när den lokala cachen i punkt 4 är på plats. En påminnelse om det
läggs i minnet.

### 4. NBA-historiken cachas lokalt

`loadHistory` (420 dagars matchstatistik) och `loadStints` (800 dagar, för RAPM)
läser i dag allt från Neon vid varje körning. Slutspelade matcher ändras aldrig.

- Ny cache på disk: `.cache/nba/history.json` och `.cache/nba/stints.json`, med
  det högsta matchid eller den senaste `boxFetchedAt` som redan finns i cachen.
- Vid varje körning hämtas bara matcher som tillkommit sedan dess, och cachen
  läggs ihop med dem.
- Cachen används bara av lokala skript. Next/Vercel läser som i dag.
- Om cachen saknas eller är trasig byggs den om från databasen.
- Varje körning skriver ut hur många rader som kom från cachen och hur många
  från databasen, så att besparingen syns i loggen.

Målet är att en vanlig körning hämtar några hundra kB i stället för flera MB.

### 5. "Uppdaterad för X h sedan" på sidorna

/skott, /cs2 och /nba visar när den senaste lyckade `lokal:*`-körningen för
sidans jobb gick, hämtat ur `SyncLog`:

- **Gult** om det gått mer än 30 timmar.
- **Rött** om den senaste körningen misslyckades, med felraden synlig.

Samma Aurora-komponenter som resten av appen används, och värdet är en siffra,
inte en mening.

## Lämnas till den som bygger

- Exakt format och filstruktur för cachen.
- Var på varje sida indikatorn sitter.
- Om CS2-linjerna kan köras oftare utan att Kambi stänger dem ute.

## Verifiering

- Kör varje jobb en gång via `run-job.cmd`. Kontrollera exit-koden, loggraden,
  `SyncLog`-raden och att ett framtvingat fel ger en notis.
- `Get-ScheduledTask BettingTracker-*` visar alla uppgifter med rätt tider.
- NBA-databasen är spärrad till 1 december, så cachen (punkt 4) kan bara
  enhetstestas tills dess: sammanslagning, ombyggnad när cachen saknas och
  att bara nya matcher hämtas. Första riktiga körningen och besparingen
  kontrolleras i december (körningens utskrift och Neon-konsolen).
- Indikatorn kontrolleras i webbläsaren på /skott, /cs2 och /nba.
