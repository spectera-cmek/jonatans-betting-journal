"use client";

/** Tidigare möten mellan lagen, kartfacit och båda lagens tio senaste serier. */

import Link from "next/link";
import { Card } from "@/components/ui";
import type { FormItem, HeadToHeadView } from "@/lib/cs2/h2h";
import { dayLabel } from "./common";

const RESULT_TXT: Record<FormItem["result"], string> = { win: "V", loss: "F", draw: "O" };

function FormStrip({ name, items }: { name: string; items: FormItem[] }) {
  // Äldst till vänster, som spelartavlans staplar.
  const rows = [...items].reverse();
  const w = items.filter((i) => i.result === "win").length;
  const l = items.filter((i) => i.result === "loss").length;
  return (
    <div className="ap-h2h-team">
      <div className="ap-h2h-teamhead">
        <b>{name}</b>
        <span className="ap-num">
          {w}–{l}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="ap-h2h-empty">Inga spelade serier i databasen.</div>
      ) : (
        <div className="ap-form-strip" role="list" aria-label={`${name}: ${w} vinster och ${l} förluster i de senaste ${items.length} serierna`}>
          {rows.map((i) => (
            <Link
              key={i.matchId}
              href={`/cs2/match/${i.matchId}`}
              role="listitem"
              className={i.result}
              title={`${dayLabel(i.startAt)}: ${i.won}–${i.lost} mot ${i.oppName}${i.oppRank ? ` (#${i.oppRank})` : ""}${i.eventName ? `, ${i.eventName}` : ""}`}
            >
              {RESULT_TXT[i.result]}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function HeadToHead({ h2h, team1, team2 }: { h2h: HeadToHeadView; team1: string; team2: string }) {
  const w1 = h2h.meetings.filter((m) => m.winner === 1).length;
  const w2 = h2h.meetings.filter((m) => m.winner === 2).length;
  return (
    <Card style={{ padding: 0, marginBottom: 16 }}>
      <div className="ap-card-head">
        <span role="heading" aria-level={2} className="ap-card-title">
          Möten och form
        </span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)" }}>
          {h2h.meetings.length ? `${team1} ${w1}–${w2} ${team2} senaste året` : "Inga möten senaste året"}
        </span>
      </div>
      <div className="ap-h2h">
        <section>
          <h3 className="ap-label ap-h2h-sub">Möten</h3>
          {h2h.meetings.length === 0 && <div className="ap-h2h-empty">Lagen har inte mötts det senaste året enligt databasen.</div>}
          {h2h.meetings.map((m) => (
            <Link key={m.matchId} href={`/cs2/match/${m.matchId}`} className="ap-h2h-row">
              <span className="ap-num ap-h2h-date">{dayLabel(m.startAt)}</span>
              <span className="ap-ell ap-h2h-event">
                {m.eventName ?? "—"} <span className="ap-h2h-fmt">{m.format.toUpperCase()}</span>
              </span>
              <span className="ap-num ap-h2h-score">
                <span className={m.winner === 1 ? "is-win" : ""}>{m.s1}</span>–<span className={m.winner === 2 ? "is-win" : ""}>{m.s2}</span>
              </span>
              <span className="ap-h2h-maps">
                {m.maps.map((mp, i) => (
                  <span key={i} className="ap-h2h-map">
                    {mp.label}{" "}
                    <span className="ap-num">
                      <span className={mp.winner === 1 ? "is-win" : ""}>{mp.r1}</span>–<span className={mp.winner === 2 ? "is-win" : ""}>{mp.r2}</span>
                    </span>
                  </span>
                ))}
              </span>
            </Link>
          ))}
          {h2h.mapRecord.length > 0 && (
            <div className="ap-h2h-record">
              <span className="ap-label">Kartfacit {team1}–{team2}</span>
              {h2h.mapRecord.map((r) => (
                <span key={r.mapName} className="ap-h2h-map">
                  {r.label}{" "}
                  <span className="ap-num">
                    {r.w1}–{r.w2}
                  </span>
                </span>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3 className="ap-label ap-h2h-sub">De tio senaste serierna</h3>
          <FormStrip name={team1} items={h2h.form.team1} />
          <FormStrip name={team2} items={h2h.form.team2} />
          <div className="ap-h2h-legend">V vinst · F förlust, äldst till vänster. Håll muspekaren över en ruta för motståndet.</div>
        </section>
      </div>
    </Card>
  );
}
