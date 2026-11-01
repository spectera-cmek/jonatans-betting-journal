import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { nbaPrisma, hasNbaDb } from "@/lib/nbaDb";
import { noNbaDb } from "@/lib/nba/api";

export const dynamic = "force-dynamic";

const MARKETS = new Set(["ml", "spread", "total"]);

// POST /api/nba/odds — ditt eget bolags pris för en match, så att edgen räknas
// mot det. Body: { gameId, book, market, line, price1, price2 }.
// Sida 1 = hemma/över. Spread-linjen anges för hemmalaget (−5,5 = hemma favorit).
export async function POST(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gameId = Number(b.gameId);
  const book = String(b.book ?? "").trim().slice(0, 40);
  const market = String(b.market ?? "");
  const price1 = Number(String(b.price1 ?? "").replace(",", "."));
  const price2 = Number(String(b.price2 ?? "").replace(",", "."));
  const lineRaw = b.line == null || b.line === "" ? null : Number(String(b.line).replace(",", "."));
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "Ogiltig match" }, { status: 400 });
  if (!book) return NextResponse.json({ error: "Ange bolag" }, { status: 400 });
  if (!MARKETS.has(market)) return NextResponse.json({ error: "Marknad måste vara ml, spread eller total" }, { status: 400 });
  if (market !== "ml" && (lineRaw == null || !Number.isFinite(lineRaw))) return NextResponse.json({ error: "Ange linje" }, { status: 400 });
  if (!(price1 > 1) || !(price2 > 1)) return NextResponse.json({ error: "Båda priserna måste vara decimalodds över 1" }, { status: 400 });
  const g = await nbaPrisma.nbaGame.findUnique({ where: { id: gameId }, select: { id: true } });
  if (!g) return NextResponse.json({ error: "Matchen finns inte" }, { status: 404 });
  const row = await nbaPrisma.nbaOdds.create({
    data: { gameId, book, market, line: market === "ml" ? null : lineRaw, price1, price2, source: "manual" },
  });
  return NextResponse.json({ ok: true, id: row.id });
}

// DELETE /api/nba/odds?id=12 — ta bort ett eget pris.
export async function DELETE(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Ogiltigt id" }, { status: 400 });
  await nbaPrisma.nbaOdds.deleteMany({ where: { id, source: "manual" } });
  return NextResponse.json({ ok: true });
}
