"use client";

/**
 * Spelartavlan: varje spelares kills mot linjen, bedömda som Jonatan väljer
 * spel — form (de tio senaste), kartan som troligen spelas och motståndet —
 * med modellen som en referens bredvid. Linjen är hans boks om den skrivits
 * in, annars Unibets, annars modellens; skriv en annan linje så räknas allt
 * om direkt i webbläsaren.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui";
import { ROLE_LABEL, type Role } from "@/lib/cs2/roles";
import {
  BOARD_SCOPE_LABEL,
  FORM_N,
  boardKey,
  buildCard,
  overRate,
  signalStrength,
  type BoardScope,
  type CardView,
  type HitStats,
  type KillSample,
  type Lean,
  type PlayerBoardData,
} from "@/lib/cs2/playerBoard";
import { mapLabel } from "@/lib/cs2/maps";
import { dayLabel, dec, pct } from "./common";

const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return s.trim() && Number.isFinite(n) && n > 0 ? n : null;
};
const lineTxt = (x: number) => String(x).replace(".", ",");
const LEAN_TXT: Record<Lean, string> = { over: "över", under: "under", even: "jämnt", thin: "för lite data" };

function frac(s: HitStats) {
  return s.over + s.under > 0 ? `${s.over}/${s.over + s.under}` : "—";
}

/** De tio senaste mot linjen. Fyllda staplar = över, ihåliga = under. */
function KillBars({ samples, line, max, data }: { samples: KillSample[]; line: number; max: number; data: PlayerBoardData }) {
  const [at, setAt] = useState<number | null>(null);
  const pad = Math.max(0, FORM_N - samples.length);
  const over = samples.filter((s) => s.kills > line).length;
  const tip = at != null ? samples[at] : null;
  const opp = tip ? data.teams[tip.oppId] : null;
  return (
    <div
      className="ap-kbars"
      role="img"
      aria-label={`${over} av ${samples.length} över ${lineTxt(line)}, äldst först: ${samples.map((s) => s.kills).join(", ")}`}
      onMouseLeave={() => setAt(null)}
    >
      <div className="ap-kbars-plot">
        {Array.from({ length: pad }, (_, i) => (
          <span key={`pad${i}`} className="ap-kbar is-empty" />
        ))}
        {samples.map((s, i) => (
          <span
            key={`${s.matchId}-${i}`}
            className={`ap-kbar ${s.kills > line ? "is-over" : s.kills < line ? "is-under" : "is-push"}`}
            onMouseEnter={() => setAt(i)}
          >
            <i style={{ height: `${Math.max(3, Math.min(100, (s.kills / max) * 100))}%` }} />
          </span>
        ))}
        <b className="ap-kbars-line" style={{ bottom: `${Math.min(100, (line / max) * 100)}%` }} aria-hidden="true" />
      </div>
      {tip && (
        <div className="ap-chart-tip ap-kbars-tip" style={{ left: `${((pad + at! + 0.5) / FORM_N) * 100}%` }}>
          <div className="ap-chart-tip-date">
            {dayLabel(tip.playedAt)} · mot {opp?.name ?? "okänt lag"}
            {opp?.rank ? ` #${opp.rank}` : ""}
          </div>
          <div className="ap-num ap-chart-tip-val">
            {tip.kills} kills
            <span>
              {tip.maps.map(mapLabel).join(" + ")} {tip.score}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Axis({ title, value, sub, lean, reference, tip }: { title: string; value: string; sub: string; lean: Lean; reference?: boolean; tip?: string }) {
  return (
    <div className={`ap-pb-axis lean-${lean}${reference ? " is-ref" : ""}`} title={`${title}: ${LEAN_TXT[lean]}${tip ? `\n${tip}` : ""}`}>
      <div className="ap-label ap-ell">{title}</div>
      <div className="ap-num v">{value}</div>
      <div className="s">{sub}</div>
    </div>
  );
}

function Pips({ c }: { c: CardView }) {
  const items: Array<[string, Lean]> = [
    ["Form", c.form.lean],
    ["Kartan", c.map.lean],
    ["Nivån", c.tier.lean],
    ["Mötena", c.h2h.lean],
  ];
  return (
    <span className="ap-pb-pips" aria-hidden="true">
      {items.map(([t, l]) => (
        <i key={t} className={l} title={`${t}: ${LEAN_TXT[l]}`} />
      ))}
    </span>
  );
}

function signalText(c: CardView): string {
  const { over, under, counted } = c.signal;
  if (counted === 0) return "För lite data för att peka åt något håll";
  if (over > 0 && under === 0) return `${over} av ${counted} pekar över`;
  if (under > 0 && over === 0) return `${under} av ${counted} pekar under`;
  if (over === 0 && under === 0) return "Jämnt mot linjen";
  return `Spretigt: ${over} över, ${under} under`;
}

function dominant(c: CardView): Lean {
  const { over, under } = c.signal;
  return over >= 2 && under === 0 ? "over" : under >= 2 && over === 0 ? "under" : "even";
}

function PlayerCard({
  c,
  data,
  scope,
  max,
  typed,
  onType,
}: {
  c: CardView;
  data: PlayerBoardData;
  scope: BoardScope;
  max: number;
  typed: string;
  onType: (v: string) => void;
}) {
  const team = c.side === 1 ? data.team1 : data.team2;
  const opp = c.h2h.opponent;
  const formRate = overRate(c.form.stats);
  const top = c.map.rows[0];
  const from =
    c.lineFrom === "typed" ? "din linje" : c.lineFrom === "book" ? c.book?.bookmaker ?? "boken" : c.lineFrom === "model" ? "modellens linje" : "formens median";
  const inputId = `pb-line-${c.playerId}-${scope}`;
  return (
    <article className={`ap-pb-card lean-${dominant(c)}`}>
      <header className="ap-pb-head">
        <div className="ap-pb-who">
          <Link href={`/cs2/spelare/${c.playerId}`} className="ap-pb-name">
            {c.nickname}
          </Link>
          <span className="ap-pb-team">{team.name}</span>
          {c.role && <span className="ap-tag">{ROLE_LABEL[c.role as Role] ?? c.role}</span>}
        </div>
        <div className="ap-pb-line">
          <label htmlFor={inputId}>Linje</label>
          <input
            id={inputId}
            className="ap-input ap-num"
            inputMode="decimal"
            value={typed}
            placeholder={lineTxt(c.book?.line ?? c.model.median ?? c.line)}
            onChange={(e) => onType(e.target.value)}
            aria-describedby={`${inputId}-from`}
          />
          <span id={`${inputId}-from`} className="ap-pb-from">
            {from}
            {c.lineFrom === "book" && c.book?.overOdds && c.book.underOdds ? (
              <span className="ap-num">
                {" "}
                Ö {dec(c.book.overOdds)} U {dec(c.book.underOdds)}
              </span>
            ) : null}
          </span>
        </div>
      </header>

      <div className="ap-pb-form">
        <KillBars samples={c.form.samples} line={c.line} max={max} data={data} />
        <div className="ap-pb-hit">
          <span className="ap-num ap-pb-big">{frac(c.form.stats)}</span>
          <span className="ap-label">över {lineTxt(c.line)}</span>
          <span className="ap-num ap-pb-avg">snitt {c.form.stats.avg != null ? dec(c.form.stats.avg, 1) : "—"}</span>
        </div>
      </div>

      <div className="ap-pb-axes">
        {scope === "maps12" ? (
          <Axis
            title="Kartorna"
            value={c.map.expected != null ? `~${dec(c.map.expected, 1)}` : "—"}
            sub={top ? `${c.map.rows.map((r) => r.label).join(", ")}` : "okänt veto"}
            lean={c.map.lean}
          />
        ) : top && top.w >= 0.9 ? (
          // Vetot är klart: en karta.
          <Axis
            title={top.label}
            value={frac(top.stats)}
            sub={top.stats.avg != null ? `snitt ${dec(top.stats.avg, 1)}` : "inga kartor där"}
            lean={c.map.lean}
          />
        ) : (
          // Vetot är öppet: andelen över, viktad med hur troligt varje karta spelas.
          <Axis
            title="Kartor"
            value={c.map.rate != null ? pct(c.map.rate) : "—"}
            sub={top ? `${top.label} ${frac(top.stats)}` : "okänt veto"}
            tip={c.map.rows.map((r) => `${r.label} ${pct(r.w)}: ${frac(r.stats)} över${r.stats.avg != null ? `, snitt ${dec(r.stats.avg, 1)}` : ""}`).join("\n")}
            lean={c.map.lean}
          />
        )}
        <Axis
          title={`Mot ${opp.name}`}
          value={frac(c.h2h.stats)}
          sub={c.h2h.stats.n ? `snitt ${dec(c.h2h.stats.avg, 1)}` : "inga möten"}
          lean={c.h2h.lean}
        />
        <Axis title={c.tier.label.charAt(0).toUpperCase() + c.tier.label.slice(1)} value={frac(c.tier.stats)} sub={c.tier.stats.n ? `snitt ${dec(c.tier.stats.avg, 1)}` : "inga utfall"} lean={c.tier.lean} />
        <Axis
          title="Modellen"
          value={c.model.pOver != null ? pct(c.model.pOver) : "—"}
          sub={c.model.mean != null ? `väntar ${dec(c.model.mean, 1)}` : "inget pris"}
          lean={c.model.pOver == null ? "thin" : c.model.pOver >= 0.55 ? "over" : c.model.pOver <= 0.45 ? "under" : "even"}
          reference
        />
      </div>

      <footer className="ap-pb-foot">
        <Pips c={c} />
        <span>{signalText(c)}</span>
        {formRate != null && c.form.stats.n < FORM_N && <span className="ap-pb-note">{c.form.stats.n} utfall i perioden</span>}
      </footer>
    </article>
  );
}

type Sort = "signal" | "team";

/**
 * Förvald karta: matchsidans förslag, men har den inga bokens linjer och en
 * annan karta har det (Unibet lägger kills per karta, aldrig karta 1–2)
 * öppnar tavlan där linjerna finns.
 */
function startScope(data: PlayerBoardData, suggested: BoardScope): BoardScope {
  const s = data.scopes.includes(suggested) ? suggested : data.scopes[0];
  const count = (sc: BoardScope) => data.players.filter((p) => data.lines[boardKey(p.playerId, sc)]).length;
  if (count(s) > 0) return s;
  const withLines = data.scopes.filter((sc) => count(sc) >= data.players.length / 2);
  return withLines[0] ?? s;
}

export function PlayerBoard({ data, initialScope }: { data: PlayerBoardData; initialScope: BoardScope }) {
  const [scope, setScope] = useState<BoardScope>(() => startScope(data, initialScope));
  const [sort, setSort] = useState<Sort>("signal");
  const [typed, setTyped] = useState<Record<string, string>>({});

  // Ordningen bygger på de sparade linjerna, så att ett kort inte flyttar sig medan du skriver.
  const base = useMemo(() => data.players.map((p) => ({ p, c: buildCard(data, p, scope) })), [data, scope]);
  const max = useMemo(() => {
    const top = Math.max(10, ...base.flatMap(({ c }) => [c.line, ...c.form.samples.map((s) => s.kills)]));
    return Math.ceil((top + 1) / 5) * 5;
  }, [base]);

  const ordered = useMemo(() => {
    const rows = [...base];
    if (sort === "signal") rows.sort((a, b) => signalStrength(b.c) - signalStrength(a.c));
    return rows;
  }, [base, sort]);

  const card = (p: (typeof base)[number]) => {
    const key = boardKey(p.p.playerId, scope);
    const t = typed[key] ?? "";
    const c = num(t) != null ? buildCard(data, p.p, scope, num(t)) : p.c;
    return <PlayerCard key={key} c={c} data={data} scope={scope} max={max} typed={t} onType={(v) => setTyped((s) => ({ ...s, [key]: v }))} />;
  };

  const withBook = base.filter(({ c }) => c.lineFrom === "book").length;

  return (
    <Card style={{ padding: 0, marginBottom: 16 }}>
      <div className="ap-card-head">
        <span role="heading" aria-level={2} className="ap-card-title">
          Spelartavla · kills
        </span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)" }}>
          {withBook > 0 ? `${withBook} av ${base.length} spelare har en linje från boken` : "Inga bokens linjer än — modellens linje visas"}
        </span>
      </div>
      <div className="ap-pb-tools">
        {data.scopes.length > 1 && (
          <div className="ap-seg" role="group" aria-label="Karta">
            {data.scopes.map((s) => (
              <button key={s} className={scope === s ? "is-active" : ""} aria-pressed={scope === s} onClick={() => setScope(s)}>
                {BOARD_SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <div className="ap-seg" role="group" aria-label="Ordning">
          <button className={sort === "signal" ? "is-active" : ""} aria-pressed={sort === "signal"} onClick={() => setSort("signal")}>
            Starkast först
          </button>
          <button className={sort === "team" ? "is-active" : ""} aria-pressed={sort === "team"} onClick={() => setSort("team")}>
            Per lag
          </button>
        </div>
        <div className="ap-pb-legend" aria-hidden="true">
          <span>
            <i className="sw-over" />
            över linjen
          </span>
          <span>
            <i className="sw-under" />
            under
          </span>
          <span>
            <i className="sw-line" />
            linjen
          </span>
          <span>de {FORM_N} senaste, äldst till vänster</span>
        </div>
      </div>
      {sort === "team" ? (
        <div className="ap-pb-cols">
          {([1, 2] as const).map((side) => (
            <div key={side} className="ap-pb-col">
              <h3 className="ap-pb-colhead">{side === 1 ? data.team1.name : data.team2.name}</h3>
              {ordered.filter(({ c }) => c.side === side).map(card)}
            </div>
          ))}
        </div>
      ) : (
        <div className="ap-pb-grid">{ordered.map(card)}</div>
      )}
      <details className="ap-fine" style={{ margin: "0 var(--pad-x) var(--pad-x)" }}>
        <summary>Så läses tavlan</summary>
        <div className="ap-fine-details">
          Kills är HLTV:s scoreboard för hela kartan, övertid inräknad. Karta 1–2 jämförs mot summan av seriens två första kartor. Ett underlag pekar när
          minst {Math.round(0.6 * 100)} % av minst fyra utfall ligger på samma sida om linjen. <b>Kartan</b> är spelarens utfall på kartorna som troligen spelas
          (vetots sannolikhet står vid kartnamnet). Rutan med <b>rankgrupp</b> (till exempel Rank 21–30) jämför med lag i samma grupp som motståndaren idag.
          Bråken räknar bara avgjorda utfall: exakt på en heltalslinje är pengarna tillbaka. Modellen är bara en referens: den
          går inte bättre än Unibets egna priser, och på kills har din egen bedömning gått bättre än modellen.
        </div>
      </details>
    </Card>
  );
}
