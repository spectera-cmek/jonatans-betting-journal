// Server-only: tolkar spelkvitto-skärmdumpar till strukturerade bets via Claude API.
// Används av POST /api/bets/parse-screenshot. Konventionerna speglar
// .cursor/rules/betslip-screenshot.mdc och fälten i lib/betInput.ts (BetInput)
// plus agent-extrafälten stakeKr/importRef/placedAt från scripts/agent/logBet.ts.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  BOOKMAKERS,
  GENERIC_MARKET_CATEGORIES,
  MARKET_CATEGORIES_BY_SPORT,
  SPORTS,
  normalizeBookmaker,
} from "./constants";

// Haiku är billigast (~5 öre/bild) och räcker för kvittoläsning; byt via env
// till t.ex. "claude-sonnet-5" om tolkningskvaliteten inte håller.
export const PARSE_MODEL = process.env.BETSLIP_PARSE_MODEL ?? "claude-haiku-4-5";

export const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

// Fälten här hålls icke-nullable med tomma defaults (tom sträng / 0) för att
// hålla nere antalet union-typade parametrar — Claudes strukturerade output
// tillåter max 16 i hela schemat. 0 tolkas som "okänt odds" (klientens
// accaOdds filtrerar bort ben ≤ 1).
const ParsedLeg = z.object({
  selection: z.string(),
  event: z.string(),
  odds: z.number(),
});

const ParsedBetSchema = z.object({
  event: z.string(),
  homeTeam: z.string().nullable(),
  awayTeam: z.string().nullable(),
  sport: z.string().nullable(),
  league: z.string().nullable(),
  market: z.enum(["h2h", "totals", "spreads", "other"]),
  marketCategory: z.string().nullable(),
  marketScope: z.enum(["player", "team", "match"]).nullable(),
  selection: z.string(),
  selectionSide: z.enum(["home", "away", "draw", "over", "under"]).nullable(),
  line: z.number().nullable(),
  betType: z.enum(["single", "accumulator", "betbuilder"]),
  legs: z.array(ParsedLeg).nullable(),
  odds: z.number().nullable(),
  stakeKr: z.number().nullable(),
  importRef: z.string().nullable(),
  bookmaker: z.string().nullable(),
  eventAt: z.string().nullable(),
  placedAt: z.string().nullable(),
});

const ExtractionSchema = z.object({ bets: z.array(ParsedBetSchema) });

export type ParsedBet = z.infer<typeof ParsedBetSchema>;

// API-svaret från parse-rutten: varje bet annoterad med ev. befintlig dubblett.
// (Klientkod får bara typ-importera härifrån — runtime-importer drar in SDK:n.)
export interface ParsedBetWithDupe extends ParsedBet {
  duplicate: { betId: string; event: string; selection: string } | null;
}

const CATEGORIES = Array.from(
  new Set([...GENERIC_MARKET_CATEGORIES, ...Object.values(MARKET_CATEGORIES_BY_SPORT).flat()])
);

// Bookmaker-namnen appen filtrerar och räknar på. "Other" är ingen bookmaker —
// kan kvittot inte identifieras ska fältet vara null, inte en uppsamlingsetikett.
const BOOKMAKER_NAMES = BOOKMAKERS.filter((b) => b !== "Other");

const EXTRACTION_PROMPT = `Du läser skärmdumpar av spelkvitton från svenska bettingappar och returnerar strukturerad JSON. En skärmdump kan innehålla FLERA bets — returnera ett element i "bets" per bet. Hittar du inget spelkvitto alls: returnera en tom lista.

## Odds och insats
- "odds" är decimalodds (t.ex. 2.50). Går oddset inte att läsa → null. HITTA ALDRIG PÅ ett odds.
- "stakeKr" är insatsen i kronor ("Insats 150,00 kr" → 150). "Utbetalning"/"Potentiell vinst" är INTE insatsen. Oläsbar insats → null.
- Börskvitton (Smarkets m.fl.): "PRIS" är oddset och "INSATS" är insatsen. "MATCHAT" (hur mycket som gått igenom) och "V&F" (vinst/förlust) är varken odds eller insats. SIDA "BUY" är ett vanligt spel; SIDA "SELL" är ett spel emot (lay) → inled då selection med "Lay: " så det inte läses som ett vanligt spel.

## Event och lag
- Amerikansk notation "PHI Phillies @ CIN Reds" betyder PHI borta, CIN hemma → event: "CIN Reds vs PHI Phillies", homeTeam: "CIN Reds", awayTeam: "PHI Phillies".
- Svensk notation "Lag A – Lag B" är redan hemma–borta → event: "Lag A vs Lag B".
- Spel utan match (outright/futures, t.ex. "Vinnare VM 2026") → event = tävlingen, homeTeam/awayTeam null.

## Marknadsmappning
- "market" är ENDAST avräkningstyp: "h2h" (matchvinnare/1X2/moneyline), "totals" (över/under på MATCHNIVÅ, t.ex. mål i matchen), "spreads" (handikapp/spread/run line), "other" (allt annat — inklusive ALLA spelarprops).
- Spelarprops (baser, skott, poäng, mål, assists, räddningar, kort m.m. för en namngiven spelare) → market: "other", marketScope: "player", och en beskrivande selection (t.ex. "JJ Bleday Över 1.5 totala baser").
- "marketScope": "player" för spelarprops, "team" för lagspecifika spel (t.ex. hörnor för ett lag), "match" för matchnivå.
- "marketCategory" är en svensk etikett, helst en av: ${CATEGORIES.join(", ")}. Passar ingen → null.
- "selectionSide": "over"/"under" för Ö/U-spel (även props), "home"/"away"/"draw" för matchvinnare/handikapp. Annars null.
- "line" för totals/spreads/props med linje (Ö 2.5 → 2.5). Annars null.

## Kvittoreferens
- "importRef" = kvittots id utan etikett: "Ref XP7687095241I" → "XP7687095241I". Leta efter "Ref", "Kupong-Id", "SpelID", "Kvitto #", "ID:". Ingen referens → null.

## Bookmaker — läs varumärket, gissa aldrig
Fältet styr både filter och vilken bookmakers stängningsodds som hämtas för CLV, så ett
felaktigt namn är sämre än inget namn.
1. Står namnet i klartext på kvittot (logga, sidhuvud, "Utgivare", app-namn, webbadress) →
   använd det. Det slår alltid utseende-ledtrådarna nedan.
2. Svara med EXAKT ett av dessa namn när kvittot är någon av dem: ${BOOKMAKER_NAMES.join(", ")}.
   Ser du en bookmaker som inte finns i listan → skriv namnet som det står på kvittot.
3. Går varumärket inte att läsa → null. Skriv ALDRIG "Bet365" (eller något annat namn) som
   gissning bara för att kvittot ser typiskt ut — null är rätt svar när du är osäker.

Utseende-ledtrådar (bara som stöd när namnet inte syns i klartext):
- Paf: VITT kvitto med mörkgrön text, rubriken "Ditt spel har lagts!", "Kvitto #" + ~11 siffror, kryssrutan "Återanvänd val", marknadsrubriker som "Asian totalt"/"Asian handikapp" → "Paf"
- HappyCasino: LILA app med ordet "happy" i regnbågsfärgade gemener uppe till vänster. Samma kvittorubrik som Paf ("Ditt spel har lagts!", "Kvitto #") — skiljs på kryssrutan "Behåll valet på kupongen" (Paf: "Återanvänd val") och den gula CASH OUT-etiketten → "HappyCasino"
- Kvittonumret ("Kvitto #" + ~11 siffror som börjar på 130…) delas av flera bolag på samma plattform (Paf, HappyCasino, SpeedyBet, veraochjohn) — det avgör ALDRIG vilken bookmaker det är.
- Smarkets: svart börs-app — flikarna "MATCHAT"/"OMATCHAT", kolumnerna "SIDA" (BUY/SELL), "INSATS" och "PRIS", knappen "HANDEL", vinst/förlust som "V&F", bottenmeny "HEM · BLÄDDRA · SPEL · KONTO" → "Smarkets"
- bet365: grön header, texten "Spel placerat", referens som börjar på "Ref XP…" → "Bet365"
- Unibet: grönt kvitto, "Kupong-Id", boostar kallas "Uniboost" → "Unibet"
- Betsson: vitt kvitto med "SINGEL ×1", eller lila "Superboost", referens "SpelID" → "Betsson"
- ComeOn: svart bakgrund, "Specialare", "Potentiell vinst" → "ComeOn"
- DBET: marinblå, tydlig "Cashout"-knapp → "DBET"
- Coolbet: mörkgula/senapsgula odds, "Boostade VM-odds" → "Coolbet"
- ATG: vitt kvitto, "Kupong-Id" → "ATG"
- Snabbare: vitt kvitto, "Specialare" → "Snabbare"
- Svenska Spel: röd app, "Odds Boost" → "Svenska Spel"
- Expekt: "Bet Builder" → "Expekt"
- Campobet: "RE USE SELECTIONS" → "Campobet"
- Interwetten: gul app, "Tips" → "Interwetten"
- Marinblå appar med referens "ID:": Betinia, Onerush eller 888sport — avgör via logotypen; syns ingen logga → null
- Flax: lila app → "Flax"
- Mr Green → "Mr Green". LeoVegas → "LeoVegas". BetMGM → "BetMGM". Betfair → "Betfair". Pinnacle → "Pinnacle". Lucky → "Lucky"
- Osäker → null. Gissa inte.

## Singlar, kombinationer och Bet Builder
- **Bet Builder / "Bygg bet" / samma-match-kombo** (rubrik som "BET BUILDER", eller flera val listade under EN gemensam insats och ETT kombinerat totalodds, oftast INOM SAMMA match): detta är ETT enda bet, ALDRIG flera. Sätt betType: "betbuilder" och lägg VARJE listad rad som ett eget ben i "legs" — missa aldrig ett ben, plocka ALDRIG bara en av raderna. event = matchen (t.ex. "Frankrike vs Marocko"). selection = kort sammanfattning av alla ben (t.ex. "Bet Builder: Under 3 mål + Hakimi 1+ skott på mål + Marocko Ö1.5 skott på mål"). market = "other" (avräknas manuellt), marketScope = "match". odds = det kombinerade totaloddset (INTE ett enskilt bens odds). stakeKr = den gemensamma insatsen.
- Vanlig kombination över FLERA matcher (dubbel/trippel/system, en insats + ett totalodds) → samma princip: betType: "accumulator", ett ben per match i "legs", event = kort sammanfattning ("Trippel: Arsenal / Real / Bayern"), odds = totaloddset.
- I varje ben (legs): selection alltid ifylld; event = benets match eller tom sträng; odds = benets odds eller 0 om det inte syns.
- FLERA SEPARATA singlar (var och en med EGEN insats och EGET odds) i samma skärmdump → flera element i "bets", varje med betType: "single" och legs: null.

## Sport, liga och tider
- "sport": helst ett av: ${SPORTS.join(", ")}. Härled från lag/liga (Phillies/Reds → Baseball, Arsenal/Serie A → Football). Osäker → null.
- "league": t.ex. "MLB", "NHL", "Allsvenskan", "Premier League", "La Liga", "Serie A", "Bundesliga", "Champions League". Krävs för fotbolls-CLV. Landslagsmatch/slutspel som tillhör fotbolls-VM 2026 → exakt "VM 2026". Osäker → null.
- "homeTeam"/"awayTeam": alltid när det är en match (krävs för auto-CLV/rättning).
- "eventAt": matchstart som ISO 8601 om den syns på kvittot, annars null. "placedAt": tidpunkt när spelet lades om den syns, annars null. Tider utan tidszon avser Europe/Stockholm (sommartid UTC+2). Gissa aldrig datum som inte syns.
- "selectionSide": home|away|draw för 1X2, over|under för totals — fyll i när det går.`;

const client = new Anthropic({ timeout: 50_000, maxRetries: 1 });

export class ParseFailedError extends Error {
  constructor() {
    super("Kunde inte tolka kvittot");
  }
}

export async function extractBetsFromScreenshot(
  imageBase64: string,
  mediaType: AllowedMediaType
): Promise<ParsedBet[]> {
  const response = await client.messages.parse({
    model: PARSE_MODEL,
    max_tokens: 4000,
    system: EXTRACTION_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "Extrahera alla bets från detta spelkvitto enligt schemat." },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  if (!response.parsed_output) throw new ParseFailedError();
  // Kanonisera bookmakern direkt vid källan ("bet 365" → "Bet365") så kvitto-
  // loggade bets hamnar på samma namn som resten av loggen — annars splittras
  // filter, analys och CLV-uppslag på stavningsvarianter.
  return response.parsed_output.bets.map((bet) => ({
    ...bet,
    bookmaker: normalizeBookmaker(bet.bookmaker),
  }));
}
