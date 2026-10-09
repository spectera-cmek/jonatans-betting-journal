"use client";

// Varning när matchens femma skiljer sig från lagets vanliga. Modellen räknar
// per lag, så en saknad nyckelspelare eller en stand-in syns inte i siffrorna.

import type { MatchupView } from "@/lib/cs2/matchup";

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function LineupChanges({ v }: { v: MatchupView }) {
  if (v.lineupChanges.length === 0) return null;
  return (
    <div className="ap-cs2-warn" style={{ marginBottom: 16 }}>
      <b>Ändrad uppställning</b>
      <span style={{ color: "var(--dim)", fontSize: 12.5 }}>
        {" "}
        — modellen räknar per lag och ser inte bytet. Väg in det själv.
      </span>
      {v.lineupChanges.map((c) => (
        <div key={c.teamId} style={{ marginTop: 6 }}>
          <b>{c.teamName}:</b>{" "}
          {c.out.map((p) => (
            <span key={p.playerId}>
              utan <b>{p.nickname}</b> ({pct(p.killShare)} av lagets kills, {p.maps}/{c.basis} kartor){" "}
            </span>
          ))}
          {c.in.map((p) => (
            <span key={p.playerId}>
              · in <b>{p.nickname}</b> ({p.mapsWithTeam === 0 ? "ny eller stand-in" : `${p.mapsWithTeam}/${c.basis} kartor med laget`}){" "}
            </span>
          ))}
        </div>
      ))}
      {!v.lineupKnown && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--dim)" }}>
          Jämfört med truppen på lagsidan — matchens egen uppställning är inte publicerad än.
        </div>
      )}
    </div>
  );
}
