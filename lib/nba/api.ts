// Delade bitar för /api/nba/*: svaret när databasen saknas och hur en
// projektion serialiseras till klienten (utan simuleringsarrayerna).

import { NextResponse } from "next/server";
import type { GameProjection } from "./pipeline";

export function noNbaDb() {
  return NextResponse.json({ dbConfigured: false });
}

export function idParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface GameDetailJson {
  dbConfigured: true;
  game: {
    id: number;
    startAt: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    home: { id: number; abbr: string; name: string };
    away: { id: number; abbr: string; name: string };
  };
  summary: GameProjection["summary"];
  fairSpread: number;
  fairTotal: number;
  homeB2B: boolean;
  awayB2B: boolean;
  home: GameProjection["home"];
  away: GameProjection["away"];
  markets: GameProjection["markets"];
  quotes: GameProjection["quotes"];
}

export function detailJson(
  g: { id: number; startAt: Date; status: string; homeScore: number | null; awayScore: number | null },
  teams: Map<number, { id: number; abbr: string; name: string }>,
  p: GameProjection
): GameDetailJson {
  const t = (id: number) => teams.get(id) ?? { id, abbr: `#${id}`, name: `Lag ${id}` };
  return {
    dbConfigured: true,
    game: {
      id: g.id,
      startAt: g.startAt.toISOString(),
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      home: t(p.home.teamId),
      away: t(p.away.teamId),
    },
    summary: p.summary,
    fairSpread: p.fairSpread,
    fairTotal: p.fairTotal,
    homeB2B: p.homeB2B,
    awayB2B: p.awayB2B,
    home: p.home,
    away: p.away,
    markets: p.markets,
    quotes: p.quotes,
  };
}
