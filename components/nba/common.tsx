"use client";

// Små delar som återkommer på NBA-sidorna.

import { Card, Empty } from "@/components/ui";
import { IC, SPORT_IC } from "@/components/icons";

export { pct, dec, dateLabel } from "@/components/cs2/common";

export type Market = "ml" | "spread" | "total";

export const MARKET_LABEL: Record<Market, string> = { ml: "Vinnare", spread: "Spread", total: "Total" };

/** "+5,5" / "−5,5" med svensk decimal. */
export const signed = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toString().replace(".", ",")}`;

/** Text för en sida: sida 1 = hemma/över, sida 2 = borta/under. */
export function sideLabel(market: Market, side: 1 | 2, line: number | null, home: string, away: string): string {
  if (market === "total") return `${side === 1 ? "Över" : "Under"} ${String(line ?? "").replace(".", ",")}`;
  const team = side === 1 ? home : away;
  if (market === "ml") return team;
  const l = line == null ? null : side === 1 ? line : -line;
  return `${team} ${signed(l)}`;
}

/** Visas när NBA_DATABASE_URL saknas. */
export function NbaNoDb() {
  return (
    <Card>
      <Empty
        icon={IC.gear}
        title="NBA-databasen är inte uppsatt"
        hint={
          <>
            Sätt <code>NBA_DATABASE_URL</code> och <code>NBA_DATABASE_URL_UNPOOLED</code> (se .env.local.example), kör{" "}
            <code>npm run db:push:nba</code> och sedan <code>npm run nba:ingest</code> på datorn. Modulen har en egen databas, skild
            från bet-loggen.
          </>
        }
      />
    </Card>
  );
}

export function NbaEmpty({ title, hint }: { title: string; hint?: React.ReactNode }) {
  return (
    <Card>
      <Empty icon={SPORT_IC.basketball} title={title} hint={hint} />
    </Card>
  );
}
