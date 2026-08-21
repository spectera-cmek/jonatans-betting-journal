"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty, Skeleton } from "@/components/ui";
import { I, IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import { fmtDateTime, fmtOdds, pctFmt } from "@/lib/format";
import type { ValuePlay } from "@/lib/valueScanner";

type Sport = { key: string; group: string; title: string; active: boolean };
type SportsResponse = { sports: Sport[] };
type ValueResponse = {
  rows: ValuePlay[];
  scannedEvents: number;
  generatedAt: string;
  cached: boolean;
};

const preferredSport = (sports: Sport[]) =>
  sports.find((sport) => sport.key === "soccer_sweden_allsvenskan")?.key ??
  sports.find((sport) => sport.key === "soccer_epl")?.key ??
  sports.find((sport) => sport.group === "Soccer")?.key ??
  sports[0]?.key ?? "";

export default function OddsPage() {
  const [sports, setSports] = useState<Sport[]>([]);
  const [sport, setSport] = useState("");
  const [data, setData] = useState<ValueResponse | null>(null);
  const [loadingSports, setLoadingSports] = useState(true);
  const [loading, setLoading] = useState(false);
  const [onlyPositive, setOnlyPositive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const scan = useCallback(async (sportKey: string) => {
    if (!sportKey) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<ValueResponse>(`/api/odds/value?sport=${encodeURIComponent(sportKey)}`);
      if (id === requestId.current) setData(result);
    } catch (e) {
      if (id === requestId.current) {
        setData(null);
        setError((e as Error).message);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api.get<SportsResponse>("/api/odds/sports")
      .then((result) => {
        if (!active) return;
        const available = (result.sports || []).filter((item) => item.active);
        setSports(available);
        setSport(preferredSport(available));
      })
      .catch((e) => active && setError((e as Error).message))
      .finally(() => active && setLoadingSports(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (sport) void scan(sport);
  }, [sport, scan]);

  const rows = data ? (onlyPositive ? data.rows.filter((row) => row.edge > 0) : data.rows) : [];

  return (
    <div>
      <Topbar
        title="Värdescanner"
        sub="Hitta bästa priset och bolaget — rangordnat efter konsensusbaserad EV."
        icon={IC.search}
      />

      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="ap-field" style={{ minWidth: 240, flex: "1 1 300px", maxWidth: 460 }}>
            <label>Serie / sport</label>
            <div className="ap-select">
              <select value={sport} onChange={(event) => setSport(event.target.value)} disabled={loadingSports || sports.length === 0}>
                {loadingSports && <option>Laddar sporter…</option>}
                {!loadingSports && sports.map((item) => <option key={item.key} value={item.key}>{item.title}</option>)}
              </select>
            </div>
          </div>
          <button className="ap-btn" onClick={() => void scan(sport)} disabled={!sport || loading}>
            <I p={IC.refresh} size={15} /> {loading ? "Skannar…" : "Uppdatera odds"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 14, fontSize: 12, color: "var(--dim)" }}>
          <button className={"ap-pill " + (onlyPositive ? "pos" : "flat")} onClick={() => setOnlyPositive((value) => !value)} style={{ border: "none", cursor: "pointer", fontFamily: "var(--sans)" }}>
            {onlyPositive ? "Visar bara +EV" : "Visar alla priser"}
          </button>
          <span>1X2 / matchvinnare · minst tre bookmakers i underlaget</span>
          {data && <span style={{ marginLeft: "auto", color: "var(--dim2)" }}>{data.scannedEvents} matcher · {data.cached ? "senaste minutens data" : `uppdaterad ${fmtDateTime(data.generatedAt)}`}</span>}
        </div>
      </Card>

      {error && (
        <Card style={{ marginBottom: 12, borderColor: "color-mix(in srgb, var(--red) 45%, var(--line))" }}>
          <div className="neg" style={{ fontWeight: 700 }}>Oddsjämförelsen kunde inte laddas</div>
          <div style={{ color: "var(--dim)", marginTop: 5, fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {loading && !data && (
        <Card><Skeleton h={18} w={230} /><Skeleton h={230} style={{ marginTop: 18 }} /></Card>
      )}

      {!loading && !error && data && rows.length === 0 && (
        <Card>
          <Empty
            icon={IC.search}
            title={onlyPositive ? "Inga +EV-priser i den här skanningen" : "Inga jämförbara priser hittades"}
            hint={onlyPositive ? "Byt serie eller visa alla priser för att se de närmaste alternativen." : "Det behövs minst tre bookmakers med samma 1X2-marknad."}
          />
        </Card>
      )}

      {data && rows.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div className="ap-card-head">
            <div>
              <div className="ap-card-title">Högst EV just nu</div>
              <div style={{ color: "var(--dim2)", fontSize: 11.5, marginTop: 3 }}>Det bästa oddset per utfall — högst konsensusavvikelse först.</div>
            </div>
            <span className="ap-pill pos">{rows.length} spel</span>
          </div>
          <div className="ap-table" style={{ overflowX: "auto" }}>
            <div className="ap-thead" style={{ gridTemplateColumns: "minmax(230px, 1.6fr) minmax(150px, 1fr) 95px 120px 95px 90px" }}>
              <span>Match</span><span>Spel</span><span className="ap-r">Bästa odds</span><span>Bookmaker</span><span className="ap-r">Fair odds</span><span className="ap-r">EV</span>
            </div>
            {rows.map((row) => (
              <div key={`${row.eventId}:${row.selection}`} className="ap-trow" style={{ gridTemplateColumns: "minmax(230px, 1.6fr) minmax(150px, 1fr) 95px 120px 95px 90px" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="ap-ell" style={{ fontWeight: 700 }}>{row.homeTeam} – {row.awayTeam}</div>
                  <div style={{ color: "var(--dim2)", fontSize: 11.5, marginTop: 3 }}>{fmtDateTime(row.commenceTime)} · {row.consensusBookmakers} bookies</div>
                </div>
                <span className="ap-ell" title={row.selection}>{row.selection}</span>
                <span className="ap-num ap-r" style={{ fontWeight: 700 }}>{fmtOdds(row.bestOdds)}</span>
                <span className="ap-tag ap-ell" title={row.bookmaker}>{row.bookmaker}</span>
                <span className="ap-num ap-r" style={{ color: "var(--dim)" }}>{fmtOdds(row.fairOdds)}</span>
                <span className={"ap-num ap-r " + (row.edge > 0 ? "pos" : "neg")} style={{ fontWeight: 800 }}>{pctFmt(row.edge * 100, true)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p style={{ color: "var(--dim2)", fontSize: 11.5, lineHeight: 1.55, margin: "12px 2px 0" }}>
        EV beräknas från medianen av varje bookmakers marginalrensade sannolikhet. Det är en signal för att jämföra priser, inte en garanti eller spelrekommendation — kontrollera alltid att linje, regler och odds fortfarande stämmer hos bolaget.
      </p>
    </div>
  );
}
