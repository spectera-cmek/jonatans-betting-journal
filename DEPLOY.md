# 📱 Lägg appen i molnet (så du kan använda den på telefonen)

Den här guiden tar dig från "appen kör bara på datorn" till "öppna den var som helst på
telefonen, även när datorn är av". Allt nedan görs **en gång**.

Du behöver: ett **GitHub**-konto (repot finns redan där), ett **Vercel**-konto (gratis),
och ca 15 minuter.

---

## 1. Skapa molndatabasen (Neon Postgres via Vercel)

1. Gå till [vercel.com](https://vercel.com) → logga in med GitHub.
2. **Add New… → Project** → importera repot `jonatans-betting-journal`.
   - Klicka **inte** Deploy än — gör steg 2 och 3 först (annars failar första bygget pga
     saknad databas). Om du redan klickat Deploy och det failade: gör klart stegen och
     tryck **Redeploy**.
3. I projektet: **Storage → Create Database → Postgres (Neon)** → välj region nära dig
   (t.ex. Frankfurt) → **Create**. Vercel kopplar in databasens connection-strings
   automatiskt som env-variabler (`DATABASE_URL`, `POSTGRES_*` m.fl.).

## 2. Sätt app-hemligheterna (env-variabler)

I Vercel: **Settings → Environment Variables**. Lägg till (Environment: *Production* +
*Preview* + *Development*):

| Namn | Värde |
|------|-------|
| `AUTH_SECRET` | En lång slumpsträng (se kommando nedan) — signerar sessionscookies |
| `INVITE_CODE` | Koden som krävs för att skapa konto — dela bara med folk du vill ha in |
| `DIRECT_URL` | Samma som `DATABASE_URL` men **utan** `-pooler` i hostnamnet *(se nedan)* |
| `ODDS_API_KEY` | (valfritt) din The Odds API-nyckel |

Generera `AUTH_SECRET` lokalt:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Om `DIRECT_URL`:** Neon ger två strängar. Den med `-pooler` i hosten = `DATABASE_URL`
(redan satt). Ta samma sträng, ta bort `-pooler` ur hostnamnet, och spara som `DIRECT_URL`.
(Behövs av `prisma db push`. Om du bara har en sträng funkar det oftast att sätta
`DIRECT_URL` = `DATABASE_URL`.)

## 3. Skapa tabellerna + flytta in din historik

Det här körs **från datorn** (en gång), mot molndatabasen:

1. Hämta connection-strings: i Vercel **Storage → din databas → .env.local / Connect**,
   kopiera `DATABASE_URL` (och `DIRECT_URL`).
2. I projektmappen, skapa filen **`.env`** med:
   ```
   DATABASE_URL="...pooler-strängen..."
   DIRECT_URL="...direkt-strängen..."
   ```
3. Kör:
   ```bash
   npm install
   npm run db:push     # skapar tabellerna i molnet
   npm run db:import   # laddar in din exporterade historik (prisma/data-export.json)
   ```
   `data-export.json` skapades redan från din SQLite-databas. Behöver du göra om exporten:
   peka `.env` på den gamla SQLite-filen och kör `npm run db:export` (kräver den gamla
   sqlite-versionen av schemat).

## 4. Deploya

Tryck **Deploy** (eller **Redeploy**) i Vercel. När det är klart får du en URL, t.ex.
`https://jonatans-betting-journal.vercel.app`.

## 5. På telefonen

1. Öppna URL:en i webbläsaren.
2. Logga in med ditt användarnamn + lösenord (eller skapa konto med inbjudningskoden).
3. **Lägg till på hemskärmen:**
   - iPhone (Safari): Dela-knappen → *Lägg till på hemskärmen*.
   - Android (Chrome): meny (⋮) → *Lägg till på startskärmen / Installera appen*.

Nu startar den som en egen app-ikon, i helskärm.

---

## Löpande: importera nya bet365-kontoutdrag

PDF-importen läser en fil från datorns disk och fungerar därför **från datorn**, men nu mot
molndatabasen (eftersom `.env` pekar dit):

```bash
# lägg kontoutdraget som statement.pdf i projektmappen, sedan:
npm run import:bet365 -- --confirm --user <ditt-användarnamn>
```

Ändringarna syns direkt på telefonen efter en omladdning.

---

## Logga bets från en molnsession (Claude Code on the web)

En molnsession kör i en container vars nätverk bara släpper ut HTTP/HTTPS — en
Postgres-socket på 5432 lämnar aldrig containern, så `scripts/agent/*` dör med ett
Prisma-initieringsfel. Neon pratar även sitt protokoll över 443, och den vägen slås
på med en flagga.

I miljödialogen på [claude.ai/code](https://claude.ai/code) (molnikonen ovanför
meddelandefältet → kugghjulet på miljön):

1. **Environment variables** — `.env`-format, en rad per variabel:
   ```
   DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require
   PRISMA_NEON_SERVERLESS=1
   ```
2. **Network access → Custom** med `*.neon.tech` i listan. Bocka i *Also include
   default list of common package managers* så npm fortsätter fungera.

Därefter går det att köra som vanligt i sessionen:

```bash
npx tsx scripts/agent/logBet.ts --file _tmp_bet.json --user jonatan
npx tsx scripts/agent/openBets.ts
```

Att känna till:

- Varje session kopierar variablerna **vid start**. Ändringar slår igenom i nästa
  session, inte i en som redan är igång.
- Molnmiljöer har ingen secrets-store — alla som använder miljön kan läsa värdena.
  Använd en Neon-roll du kan rotera, och rotera den om du delar sessionen.
- Flaggan gäller bara Neon. Lämnas den osatt är det exakt samma TCP-anslutning som
  förut, så Vercel och lokal körning påverkas inte.
- `DIRECT_URL` behövs inte i molnet — bara `prisma db push` och migrationerna använder den.

## Felsökning

- **Första bygget failar med databas-/Prisma-fel:** env-variablerna saknades vid bygget.
  Lägg in dem (steg 1–2) och tryck **Redeploy**.
- **"Inloggning är inte konfigurerad":** `AUTH_SECRET` saknas i Vercel.
- **"Registrering är inte konfigurerad":** `INVITE_CODE` saknas i Vercel.
- **Utloggad hela tiden:** `AUTH_SECRET` skiljer sig mellan Production och Preview — sätt
  samma värde i alla miljöer.
- **`DATABASE_URL is not set` i ett skript:** `.env` saknas lokalt, eller så saknas
  variabeln i molnmiljöns *Environment variables*.
- **`Could not reach … over the Neon serverless transport`:** `*.neon.tech` saknas i
  miljöns allowlist, eller så pekar `DATABASE_URL` på en host som inte är Neon.
- **Glömt lösenord:** det finns ingen självbetjäning — ägaren får sätta ett nytt hash direkt
  i databasen (eller skapa ett nytt konto och importera om).
