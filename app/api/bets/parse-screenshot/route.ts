import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import {
  extractBetsFromScreenshot,
  ParseFailedError,
  ALLOWED_MEDIA_TYPES,
  type AllowedMediaType,
  type ParsedBet,
  type ParsedBetWithDupe,
} from "@/lib/betslipExtract";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // vision-anropet tar typiskt 3–15 s

// Klienten komprimerar till ~200–500 KB; gränsen skyddar mot råa original.
// (base64 är ~4/3 av byte-storleken → ~7M tecken ≈ 5 MB bild.)
const MAX_BASE64_CHARS = 7_000_000;

// POST /api/bets/parse-screenshot — tolka en kvitto-skärmdump till bets.
// Body: { imageBase64: string, mediaType: "image/jpeg" | ... }
export async function POST(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("parse-screenshot: ANTHROPIC_API_KEY saknas i miljön");
    return NextResponse.json({ error: "Tolkningstjänsten är inte konfigurerad" }, { status: 500 });
  }

  let imageBase64: unknown, mediaType: unknown;
  try {
    ({ imageBase64, mediaType } = await req.json());
  } catch {
    return NextResponse.json({ error: "Ogiltig request-body" }, { status: 400 });
  }
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    return NextResponse.json({ error: "imageBase64 saknas" }, { status: 400 });
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return NextResponse.json({ error: "Bilden är för stor (max ~5 MB)" }, { status: 413 });
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType as AllowedMediaType)) {
    return NextResponse.json({ error: "Bildformatet stöds inte" }, { status: 400 });
  }

  let bets: ParsedBet[];
  try {
    bets = await extractBetsFromScreenshot(imageBase64, mediaType as AllowedMediaType);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("parse-screenshot: ogiltig/saknad ANTHROPIC_API_KEY", e);
      return NextResponse.json({ error: "Tolkningstjänsten är inte konfigurerad" }, { status: 500 });
    }
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
      return NextResponse.json({ error: "Tolkningstjänsten är upptagen — försök igen strax" }, { status: 502 });
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return NextResponse.json({ error: "Kunde inte nå tolkningstjänsten — försök igen" }, { status: 502 });
    }
    if (e instanceof Anthropic.APIError) {
      console.error("parse-screenshot: API-fel", e);
      return NextResponse.json({ error: "Tolkningen misslyckades — försök igen" }, { status: 502 });
    }
    if (e instanceof ParseFailedError) {
      return NextResponse.json({ error: "Kunde inte tolka kvittot — logga betet manuellt" }, { status: 422 });
    }
    console.error("parse-screenshot: oväntat fel", e);
    return NextResponse.json({ error: "Kunde inte tolka kvittot — logga betet manuellt" }, { status: 422 });
  }

  // Dubblettkoll på kvittoreferens — rådgivande varning, blockerar inte.
  const refs = bets.map((b) => b.importRef).filter((r): r is string => !!r);
  const existing = refs.length
    ? await prisma.bet.findMany({
        where: { userId, importRef: { in: refs } },
        select: { id: true, importRef: true, event: true, selection: true },
      })
    : [];
  const byRef = new Map(existing.map((b) => [b.importRef as string, b]));

  const withDupes: ParsedBetWithDupe[] = bets.map((b) => {
    const dupe = b.importRef ? byRef.get(b.importRef) : undefined;
    return {
      ...b,
      duplicate: dupe ? { betId: dupe.id, event: dupe.event, selection: dupe.selection } : null,
    };
  });

  return NextResponse.json({ bets: withDupes });
}
