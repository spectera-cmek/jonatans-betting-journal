import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId, safeEqual } from "@/lib/auth";
import { captureHistoricalClv } from "@/lib/clvHistorical";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Lämna marginal till Vercels timeout så svaret hinner skrivas. */
const DEADLINE_MS = 45_000;

/**
 * GET /api/cron/clv — hämtar closing odds i efterhand.
 *
 * Körs av Vercel Cron (se vercel.json). Det är hela poängen med den här
 * endpointen: den gamla automatiken var en Windows-uppgift på Jonatans laptop,
 * så CLV slutade uppdateras så fort datorn var avstängd — och den saknade
 * dessutom API-nyckel i varenda körning. På servern finns nyckeln, och krontabben
 * bryr sig inte om laptopen.
 *
 * Auktorisering: Vercel skickar `Authorization: Bearer $CRON_SECRET`. En inloggad
 * session släpps också in, så knappen i Inställningar kan köra samma jobb.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const num = (name: string, fallback: number) => {
    const raw = Number(searchParams.get(name));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };

  try {
    const result = await captureHistoricalClv({
      sinceDays: num("sinceDays", 60),
      limit: num("limit", 80),
      maxCredits: num("maxCredits", 1500),
      minRemaining: num("minRemaining", 500),
      deadlineMs: Date.now() + DEADLINE_MS,
    });

    // Logga alltid — även nollkörningar. Att automatiken var tyst i en månad var
    // precis varför felet inte upptäcktes förrän kreditmätaren stod still.
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary:
          `Historisk CLV: ${result.closingUpdated} closing av ${result.eligible} hämtbara ` +
          `(${result.creditsSpent} krediter, ${result.remaining ?? "?"} kvar)` +
          (result.stopped ? ` — ${result.stopped}` : ""),
      },
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron/clv]", e);
    await prisma.syncLog
      .create({ data: { kind: "closing", summary: `Historisk CLV misslyckades: ${message}` } })
      .catch(() => {});
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ") && safeEqual(header.slice(7), secret)) return true;
  }
  return !!getSessionUserId();
}
