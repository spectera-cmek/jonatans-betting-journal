// Server-only: läser en skärmdump av en boks CS2-props (kills, headshots,
// första kill …) till linjer via Claude. Används av
// POST /api/cs2/lines/parse-screenshot. Samma upplägg som lib/betslipExtract.ts
// (strukturerad output via zod), men för en lista linjer i stället för ett kvitto.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const PROPS_PARSE_MODEL = process.env.CS2_PROPS_PARSE_MODEL ?? "claude-opus-5-5";

const PropRow = z.object({
  player: z.string(),
  market: z.enum(["kills", "headshots", "player_first_kill", "other"]),
  scope: z.enum(["map1", "map2", "map3", "maps12", "match"]),
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

const PROMPT = `Du läser skärmdumpar av svenska/europeiska bettingappars CS2-marknader (Counter-Strike 2) och returnerar strukturerad JSON. En skärmdump innehåller oftast en lista spelarlinjer. Returnera en rad per spelare och linje.

- "player": spelarens nick exakt som det står (t.ex. "ZywOo", "ropz"). Lagnamn är INTE spelare.
- "market": "kills" (antal kills), "headshots" (antal headshots), "player_first_kill" (spelaren tar första kill / first blood), annars "other".
- "scope": "map1"/"map2"/"map3" för en enskild karta ("Karta 1", "Map 1"), "maps12" för summan av karta 1 och 2 ("Kartor 1-2", "Maps 1-2"), "match" för hela matchen.
- "line": linjen (Över/Under 38.5 → 38.5). Saknas linje (ja/nej-marknad) → null.
- "overOdds"/"underOdds": decimalodds för Över respektive Under. För ja/nej-marknader: ja = overOdds, nej = underOdds. Oläsbart → null. HITTA ALDRIG PÅ odds.
- "includesOt": true om boken skriver att övertid räknas, false om den skriver att den inte räknas, annars null.
- "bookmaker": boken om den går att identifiera (bet365, Unibet, Betsson, …), annars null.
Hittar du inga CS2-spelarlinjer: returnera en tom lista.`;

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
    max_tokens: 8000,
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
          { type: "text", text: "Extrahera alla CS2-spelarlinjer enligt schemat." },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new PropsParseFailedError("Tolkningen avböjdes — mata in linjerna manuellt");
  if (!response.parsed_output) throw new PropsParseFailedError();
  return response.parsed_output;
}
