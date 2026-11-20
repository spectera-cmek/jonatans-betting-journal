# CS2 del 1: siffror att lita på

2026-11-20 · Status: utkast, väntar på Jonatans godkännande

## Syfte

Jonatan öppnar CS2-fliken för att ta reda på vad han ska spela inför kommande
matcher, mest kills-props och dueller. Han vill se informationen snabbare och
kunna lita på den. Det här är del 1 av fyra (1 pålitlighet, 2 angles som
konkreta edgar, 3 gameplan-docen som betting-underlag, 4 fart). Del 1 tar bort
de tre fel som gör att sidan i dag visar siffror som inte går att lita på.

## Läget i dag

- **Rundhandikapp läses som karthandikapp.** Unibets "Round Handicap" (hela
  matchen, i rundor) har inget kartnummer, så `marketOf` i `lib/cs2/kambi.ts`
  gör den till `match_handicap`. Det ger edgar på upp till +126 % och
  ½ Kelly på över 100 u. Upp till 106 rader i 11 matcher, alla med en
  projektion, 13–18 redan avgjorda och därmed med i Facit.
- **Linjer syns flera gånger.** `/api/cs2/matches/[id]` läser alla sparade
  versioner av en linje. När Unibet ändrar oddsen sparas en ny version (930
  äldre versioner finns), och matchsidan och Angles visar alla. Facit tar redan
  bara den senaste (`latestPerLine` i `lib/cs2/settle.ts`). Dessutom finns 11
  exakta dubbletter från två hämtningar som gick samtidigt 2026-11-18.
- **HLTV-jobbet går aldrig klart.** 2026-11-19 fastnade en resultatsida i
  Cloudflares kontroll. Scrapling svarade inte inom 180 s och felet avbröt hela
  `cs2:update`, eftersom `runIngest` bara fångar sidtaksfelet. Kommande matcher
  (veto, uppställningar), kartstatistik, demos, Unibet-linjer, facit och roller
  hoppades därmed över. Senaste spelade match i databasen är från 18/11.

## Mål

1. Bara marknader som modellen prissätter rätt sparas och visas.
2. Varje linje syns en gång, med de senaste oddsen.
3. Ett enskilt HLTV-fel stoppar inte resten av körningen.
4. De felaktiga raderna är borta ur databasen, och Facit räknas utan dem.

## Icke-mål

- Ingen prissättning av rundhandikapp över hela matchen. Det är en ny marknad
  för modellen och får vänta.
- Ingen visning av hur linjen rört sig. Versionerna sparas kvar för del 2.
- Inget synligt webbläsarfönster som reserv när Cloudflare krånglar.

## Anti-mål

- Att rensningen tar bort riktiga linjer (karthandikapp ±1,5 i Bo3).
- Att jobbet tyst räknas som lyckat när nästan inget hämtades.
- Notisspam vid enstaka sidor som inte gick att hämta.

## Tillvägagångssätt

| Fel | Valt | Bortvalt |
|---|---|---|
| Rundhandikapp | Bo1: räkna den som kartans rundhandikapp (`map_handicap`, karta 1). Bo3 och Bo5: hoppa över. | Prissätta rundhandikapp över serien: nytt projekt. |
| Dubbletter | Matchsidan visar bara senaste versionen per linje och bok (samma regel som Facit). Unibet-hämtningen skriver per match i en kort transaktion med lås, så att två körningar inte kan spara samma version. | Skriva över oddsen i stället för att spara versioner: tappar historiken som del 2 behöver. |
| HLTV-jobbet | Ett sidfel loggas och hoppas över. Sidor som fastnar får ett nytt försök med en nystartad Scrapling. Steg 2–5 körs även om HLTV-steget fallerar. | Synlig webbläsare som reserv: Jonatan vill inte ha fönster som dyker upp. |
| Felaktiga rader | Radera, med backup först. | Låta dem ligga och filtrera överallt: varje fråga måste komma ihåg det. |

Jonatan valde att radera med backup. Resten är mina val.

## Design

### Rundhandikapp (`lib/cs2/kambi.ts`, `lib/cs2/lineStore.ts`)

- `marketOf` skiljer "Round Handicap" utan kartnummer från "Map Handicap" och
  ger den en egen intern etikett.
- `kambiRowsForMatch` känner matchens format. I Bo1 blir raden
  `map_handicap` på karta 1. Annars faller den bort som `other`.
- Skärmdumpstolkningen (`propsExtract.ts`) ska följa samma regel om den har
  samma lucka. Det får byggaren kontrollera.

### Senaste versionen (`app/api/cs2/matches/[id]/route.ts`)

- Linjerna filtreras till den senaste per bok och `lineKey` innan
  `buildMatchupView`. Antalet linjer i matchlistan (`queries.ts`) räknas på
  samma sätt.

### Lås vid sparning (`lib/cs2/lineStore.ts`)

- Per match: hämta Unibet först (nätverk), öppna sedan en kort transaktion med
  `pg_advisory_xact_lock(matchId)`, läs de sparade linjerna, kör
  `changedLines` och skriv. Det fungerar genom Neons pool.
  Knappen "Hämta från Unibet" går samma väg.

### HLTV-jobbet (`lib/cs2/pipeline.ts`, `lib/cs2/hltv/session.ts`, `scripts/cs2/update.ts`)

- Ranking, lagsidor, resultatlistor och kommande matcher fångar fel per sida
  och lägger dem i `summary.errors`, precis som match- och kartsidorna redan gör.
- `fetchViaScrapling` försöker en gång till efter `timeout` eller `worker_died`.
- I `update.ts` körs HLTV-steget i en egen try. Demos hoppas över om det
  fallerade, men linjer, facit och roller körs ändå.
- Jobbet avslutas med fel, och skickar notis, bara om HLTV-steget kastade ett
  fel eller om fler än hälften av sidorna fallerade. Annars slutar det med en
  rad som säger hur många sidor som hoppades över.

### Rensning (engångsskript under `scripts/cs2/`)

- Backup först till `.claude/backups/` i huvudmappen: raderna och deras
  projektioner som JSON.
- Raderas: `match_handicap` med |linje| ≥ 2,5 i Bo3, ≥ 1 i Bo1 och ≥ 3,5 i
  Bo5 (101 rader), plus de Bo5-rader på ±2,5 som sparades i samma hämtning som
  rundstegen (högst 5, avgörs per rad, lämnas kvar vid tvekan). Dessutom de 11
  exakta dubbletterna, alltid den senare av två. Projektionerna med samma
  `lineId` raderas med.
- Skriptet visar vad det ska ta bort och kräver `--confirm` för att göra det.

## Prov

- Enhetstester: `marketOf`/`kambiRowsForMatch` för "Round Handicap" i Bo1 och
  Bo3, senaste-version-filtret och att `runIngest` fortsätter när en
  resultatsida kastar.
- Efter rensningen: PARIVISION–DENDELE ska visa 1 matchvinnarlinje och inga
  handikapp från ±2,5 och uppåt. Facit räknar 13–18 avgjorda linjer färre.

## Lämnat åt byggaren

- Exakt gräns för "nästan inget hämtades".
- Om `propsExtract.ts` har samma lucka.
- Formuleringen på slutraden i loggen.

## Efter sammanslagning

Vercel driftsätter sidan från `main`. Schemalagda jobb körs från huvudmappen,
så den behöver `git pull` innan nästa `cs2:update` (10:00) använder den nya
koden.
