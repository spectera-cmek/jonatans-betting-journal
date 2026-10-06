// Server-only: läser en skärmdump av en boks CS2-marknader (spelarprops som
// kills och headshots, men också vinnare, handikapp, rundor, antal kartor,
// pistol och första kill) till linjer via Claude. Används av
// POST /api/cs2/lines/parse-screenshot. Samma upplägg som lib/betslipExtract.ts
// (strukturerad output via zod), men för en lista linjer i stället för ett kvitto.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

// Ren avläsning av namn och tal i kartpausen — snabbhet går före. Sonnet 5.5
// på låg effort räcker; CS2_PROPS_PARSE_MODEL kan sätta en annan modell.
export const PROPS_PARSE_MODEL = process.env.CS2_PROPS_PARSE_MODEL ?? "claude-sonnet-5-5";

/** Marknaderna modellen kan prissätta (Cs2Market) + "other" för resten. */
export const PROP_MARKETS = [
  "kills",
  "headshots",
  "player_first_kill",
  "rounds",
  "map_winner",
  "map_handicap",
  "match_winner",
  "match_handicap",
  "total_maps",
  "pistol",
  "first_kill",
  "other",
] as const;

const PropRow = z.object({
  market: z.enum(PROP_MARKETS),
  scope: z.enum(["map1", "map2", "map3", "maps12", "match"]),
  /** Spelarens nick för spelarmarknader, annars null. */
  player: z.string().nullable(),
  /** Laget som "overOdds" och linjen gäller för lagmarknader, annars null. */
  team: z.string().nullable(),
  line: z.number().nullable(),
  overOdds: z.number().nullable(),
  underOdds: z.number().nullable(),
  /** true/false om boken skriver ut regeln, annars null. */
  includesOt: z.boolean().nullable(),
});

const PropsSchema = z.object({
  bookmaker: z.string().nullable(),
  rows: z.array(PropRow),
});

export type ParsedPropRow = z.infer<typeof PropRow>;
export type ParsedProps = z.infer<typeof PropsSchema>;

const PROMPT = `Du läser skärmdumpar av svenska/europeiska bettingappars CS2-marknader (Counter-Strike 2) och returnerar strukturerad JSON. En skärmdump kan innehålla många olika marknader — läs ALLA du ser och returnera en rad per marknad och linje.

Fält:
- "market": se listan nedan. Marknader som inte passar → "other".
- "scope": "map1"/"map2"/"map3" för en enskild karta ("Karta 1", "Map 1"), "maps12" för summan av karta 1 och 2 ("Kartor 1-2", "Maps 1-2"), "match" för hela matchen.
- "player": spelarens nick exakt som det står, för spelarmarknader. Annars null.
- "team": lagnamnet exakt som det står, för lagmarknader (se nedan vilket lag). Annars null.
- "line": linjen som tal (Över/Under 38.5 → 38.5, handikapp -1.5 → -1.5). Ingen linje → null.
- "overOdds"/"underOdds": decimalodds. Oläsbart → null. HITTA ALDRIG PÅ odds.
- "includesOt": true om boken skriver att övertid räknas, false om den skriver att den inte räknas, annars null.
- "bookmaker": boken om den går att identifiera (bet365, Unibet, Betsson, …), annars null.

Marknader:
- "kills" / "headshots": spelarens antal kills / headshots, Över/Under en linje. player = nick, overOdds = Över, underOdds = Under.
- "player_first_kill": spelaren tar första kill (first blood) i första rundan på kartan. overOdds = Ja, underOdds = Nej.
- "match_winner": vem vinner matchen. team = laget som står FÖRST, overOdds = det lagets odds, underOdds = det andra lagets odds. line = null. scope = "match".
- "map_winner": vem vinner en karta (scope map1/map2/map3). Som match_winner.
- "match_handicap": karthandikapp på matchen (t.ex. "-1.5 kartor"). team = laget vars handikapp står vid FÖRSTA oddset, line = det lagets handikapp (t.ex. -1.5 eller +1.5), overOdds = det lagets odds, underOdds = motståndarens odds på motsatt handikapp. scope = "match".
- "map_handicap": rundhandikapp på en karta (t.ex. "-3.5 rundor", scope map1/map2/map3). Som match_handicap.
- "rounds": totalt antal rundor på en karta, Över/Under (scope map1/map2/map3). team = null.
- "total_maps": totalt antal kartor i matchen, Över/Under (t.ex. 2.5). scope = "match", team = null.
- "pistol": vem vinner FÖRSTA pistolrundan på kartan. team = laget som står först, overOdds = dess odds, underOdds = det andra lagets. Andra pistolrundan → "other".
- "first_kill": vilket lag tar första kill i första rundan på kartan. Som pistol.

Hittar du inga CS2-marknader: returnera en tom lista.`;

const client = new Anthropic({ timeout: 90_000, maxRetries: 1 });

export class PropsParseFailedError extends Error {
  constructor(reason = "Kunde inte tolka skärmdumpen") {
    super(reason);
  }
}

export async function extractPropsFromScreenshot(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"
): Promise<ParsedProps> {
  const useFallback = PROPS_PARSE_MODEL === "claude-opus-5-5";
  const response = await client.beta.messages.parse({
    model: PROPS_PARSE_MODEL,
    max_tokens: 12000,
    system: PROMPT,
    // Ren avläsning — låg effort räcker och håller nere kostnaden.
    output_config: { effort: "low", format: betaZodOutputFormat(PropsSchema) },
    // Avböjer modellen av policyskäl körs samma anrop om på reservmodellen.
    ...(useFallback ? { betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: "claude-opus-4-8" }] } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "Extrahera alla CS2-marknader enligt schemat." },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new PropsParseFailedError("Tolkningen avböjdes — mata in linjerna manuellt");
  if (!response.parsed_output) throw new PropsParseFailedError();
  return response.parsed_output;
}
