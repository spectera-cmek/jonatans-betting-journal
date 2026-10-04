"use client";

// Små delar som återkommer på CS2-sidorna.

import Link from "next/link";
import { Card, Empty } from "@/components/ui";
import { IC } from "@/components/icons";

export const pct = (x: number | null | undefined, digits = 0) =>
  x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(digits)} %`;
export const dec = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "—" : x.toFixed(d).replace(".", ",");
export const dateLabel = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { day: "2-digit", month: "short" });

/** Visas när CS2_DATABASE_URL saknas. */
export function Cs2NoDb() {
  return (
    <Card>
      <Empty
        icon={IC.gear}
        title="CS2-databasen är inte uppsatt"
        hint={
          <>
            Sätt <code>CS2_DATABASE_URL</code> och <code>CS2_DATABASE_URL_UNPOOLED</code> (se .env.local.example), kör{" "}
            <code>npm run db:push:cs2</code> och sedan <code>npm run cs2:ingest -- --confirm</code> på datorn. Modulen har en
            egen databas, skild från bet-loggen.
          </>
        }
      />
    </Card>
  );
}

export function Cs2Empty({ title, hint }: { title: string; hint?: React.ReactNode }) {
  return (
    <Card>
      <Empty icon={IC.gamepad} title={title} hint={hint} />
    </Card>
  );
}

/** Väljare för docens SAMPLE SIZE: senaste N kartor inom M månader. */
export function SampleWindowPicker({
  maps,
  months,
  onChange,
  showMaps = true,
}: {
  maps: number;
  months: number;
  onChange: (w: { maps: number; months: number }) => void;
  showMaps?: boolean;
}) {
  return (
    <>
      {showMaps && (
        <div className="ap-field">
          <label htmlFor="cs2-maps">Kartor</label>
          <div className="ap-select">
            <select id="cs2-maps" value={maps} onChange={(e) => onChange({ maps: Number(e.target.value), months })}>
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  senaste {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className="ap-field">
        <label htmlFor="cs2-months">Period</label>
        <div className="ap-select">
          <select id="cs2-months" value={months} onChange={(e) => onChange({ maps, months: Number(e.target.value) })}>
            {[1, 3, 6, 12].map((n) => (
              <option key={n} value={n}>
                {n} mån
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}

export function TeamLink({ id, name }: { id: number | null; name: string }) {
  if (id == null) return <span>{name}</span>;
  return (
    <Link href={`/cs2/lag/${id}`} style={{ color: "inherit", fontWeight: 600 }}>
      {name}
    </Link>
  );
}

export function SideLegend() {
  return (
    <span className="ap-cs2-legend">
      <span>
        <i style={{ background: "var(--cs2-ct)" }} />
        CT = blå
      </span>
      <span>
        <i style={{ background: "var(--cs2-t)" }} />T = gul
      </span>
    </span>
  );
}
