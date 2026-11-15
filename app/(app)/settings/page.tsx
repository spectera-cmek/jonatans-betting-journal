"use client";

import { useEffect, useRef, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Field } from "@/components/ui";
import { SyncButton } from "@/components/SyncButton";
import { ImportPanel } from "@/components/ImportPanel";
import { api } from "@/lib/fetcher";
import Link from "next/link";
import { useMetrics, useSettings } from "@/lib/useData";
import { FABRICATED_TAG, QUALITY_FLAG_HINTS, QUALITY_FLAG_LABELS, type QualityFlag } from "@/lib/dataQuality";
import type { SettingsDTO } from "@/lib/types";
import { I, IC } from "@/components/icons";
import { useTheme } from "@/components/ThemeProvider";

export default function SettingsPage() {
  const { mode, setMode } = useTheme();
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [unitValue, setUnitValue] = useState("100");
  const [currency, setCurrency] = useState("kr");
  const [dailyBudget, setDailyBudget] = useState("");
  const [weeklyBudget, setWeeklyBudget] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Shares the cached /api/settings entry with the nav instead of fetching its
  // own copy. Seeded once: a background revalidation must never overwrite edits
  // the user is in the middle of typing.
  const { data: fetched, reload: reloadSettings } = useSettings();
  const seeded = useRef(false);
  useEffect(() => {
    if (!fetched || seeded.current) return;
    seeded.current = true;
    setSettings(fetched);
    setUnitValue(String(fetched.unitValue));
    setCurrency(fetched.currency);
    setDailyBudget(fetched.dailyStakeBudgetUnits != null ? String(fetched.dailyStakeBudgetUnits) : "");
    setWeeklyBudget(fetched.weeklyStakeBudgetUnits != null ? String(fetched.weeklyStakeBudgetUnits) : "");
  }, [fetched]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const s = await api.put<SettingsDTO>("/api/settings", {
        unitValue: Number(unitValue),
        currency,
        dailyStakeBudgetUnits: dailyBudget.trim() === "" ? null : Number(dailyBudget),
        weeklyStakeBudgetUnits: weeklyBudget.trim() === "" ? null : Number(weeklyBudget),
      });
      // PUT doesn't echo username — keep the one from the initial GET.
      setSettings((prev) => ({ ...s, username: prev?.username }));
      // Refresh the shared cache so the nav (and a later revisit) sees the new
      // unit value rather than the pre-save copy.
      reloadSettings();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const saveRow = (
    <div className="ap-set-actions">
      <button className="ap-btn" onClick={save} disabled={saving}>{saving ? "Sparar…" : "Spara"}</button>
      {saved && <span className="pos ap-t-md" role="status">✓ Sparat</span>}
    </div>
  );

  return (
    <div>
      <Topbar title="Inställningar" sub="Enhetsvärde, valuta och synkronisering" />

      <div className="ap-settings">
        <Section title="Utseende" note="Mörkt som en skärm eller ljust som en utskrift. Bärnsten markerar det som går att klicka på; grönt och rött är reserverat för resultat.">
          <div className="ap-seg" role="group" aria-label="Färgläge">
            <button className={mode === "dark" ? "is-active" : ""} aria-pressed={mode === "dark"} onClick={() => setMode("dark")}>
              <I p={IC.moon} size={13} /> Mörkt
            </button>
            <button className={mode === "light" ? "is-active" : ""} aria-pressed={mode === "light"} onClick={() => setMode("light")}>
              <I p={IC.sun} size={13} /> Ljust
            </button>
          </div>
        </Section>

        <Section title="Konfiguration" note="Vad en unit är värd, och i vilken valuta beloppen visas.">
          <div className="ap-x2">
            <Field label="Enhetsvärde (valuta per 1U)">
              <input className="ap-input ap-num" type="number" value={unitValue} onChange={(e) => setUnitValue(e.target.value)} />
            </Field>
            <Field label="Valuta">
              <input className="ap-input" value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </Field>
          </div>
          {saveRow}
        </Section>

        <Section
          title="Tilt-vakt"
          note="Ett tak för hur många units du satsar per dag och vecka. När du närmar dig taket — eller när insatserna ökar under en förlustsvit — visas en varning på översikten. Lämna tomt för att stänga av."
        >
          <div className="ap-x2">
            <Field label="Dagsbudget (U)">
              <input className="ap-input ap-num" type="number" min="0" placeholder="av" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
            </Field>
            <Field label="Veckobudget (U)">
              <input className="ap-input ap-num" type="number" min="0" placeholder="av" value={weeklyBudget} onChange={(e) => setWeeklyBudget(e.target.value)} />
            </Field>
          </div>
          {saveRow}
        </Section>

        <DataQualitySection />

        <Section title="Kontoutdrag (Bet365)" note="Auto-rättning från ett kontoutdrag.">
          <ImportPanel />
        </Section>

        <Section
          title="Rätta via resultat"
          note={
            <>
              Gratis, utan API-nyckel. Rättar öppna <strong>singel-bets</strong> (1X2, över/under, handikapp) på NBA, NHL,
              MLB, NFL och stora fotbollsligor via slutresultat. Ackumulatorer och special-marknader rättas via
              kontoutdraget ovan.
            </>
          }
        >
          <SyncButton kind="scores" label="Rätta via resultat" showResult />
        </Section>

        <Section title="CLV & synk" note="API-nycklar för stängningsodds och automatisk rättning.">
          <div className="ap-keylist">
            <div className="ap-legrow">
              <i className={"ap-led" + (settings?.hasTheStatsApiKey ? " is-on" : "")} aria-hidden="true" />
              <span style={{ flex: 1 }}>TheStatsAPI</span>
              {settings?.hasTheStatsApiKey ? <span className="pos">ansluten</span> : <span className="neg">ingen nyckel</span>}
            </div>
            <div className="ap-legrow">
              <i className={"ap-led" + (settings?.hasOddsApiKey ? " is-on" : "")} aria-hidden="true" />
              <span style={{ flex: 1 }}>The Odds API</span>
              {settings?.hasOddsApiKey ? <span className="pos">ansluten</span> : <span className="neg">ingen nyckel</span>}
            </div>
          </div>

          {settings?.hasTheStatsApiKey || settings?.hasOddsApiKey ? (
            <>
              <p className="ap-note">
                {settings?.hasTheStatsApiKey
                  ? "TheStatsAPI hämtar historiska stängningsodds (CLV) för fotboll — även retroaktivt. Synken kör i små batchar (undviker 504); kör igen för fler bets. "
                  : ""}
                {settings?.hasOddsApiKey
                  ? "The Odds API länkar icke-fotboll och ger live-closing som fallback. "
                  : ""}
                ESPN-resultat rättar singlar utan API-länk.
              </p>
              <div className="ap-set-actions" style={{ alignItems: "flex-start" }}>
                <SyncButton kind="closing" label="Hämta closing-odds" showResult />
                <SyncButton kind="all" label="Full synk" showResult />
                {settings?.hasOddsApiKey && <SyncButton kind="grade" label="Rätta via Odds API" showResult />}
              </div>
            </>
          ) : (
            <div className="ap-note">
              <p>Lägg till minst en API-nyckel i <code>.env.local</code>:</p>
              <ul>
                <li><strong>THESTATSAPI_KEY</strong> — historisk CLV för fotboll (rekommenderas). thestatsapi.com</li>
                <li><strong>ODDS_API_KEY</strong> — gratis tier för MLB/NBA/NHL m.fl. the-odds-api.com</li>
              </ul>
              <p>
                Utan nycklar fungerar gratis ESPN-rättning ovan. CLV: använd refresh-knappen
                bredvid varje bets CLV-cell (OddsPortal-scrape, kräver Playwright lokalt) eller
                TheStatsAPI/Odds API.
              </p>
            </div>
          )}
        </Section>

        <Section title="Data" note="Hela journalen som en fil.">
          <div>
            <a className="ap-btn ghost" href="/api/bets/export"><I p={IC.download} size={15} /> Exportera alla bets (CSV)</a>
          </div>
        </Section>

        <Section
          title="Konto"
          note={settings?.username ? <>Inloggad som <strong>{settings.username}</strong></> : undefined}
        >
          <div>
            <button
              className="ap-btn ghost"
              onClick={async () => {
                await fetch("/api/login", { method: "DELETE" });
                window.location.href = "/login";
              }}
            >
              Logga ut
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

/** One settings group: name and explanation on the left, controls on the right. */
function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="ap-set">
      <div className="ap-set-head">
        <h2 className="ap-card-title">{title}</h2>
        {note && <p className="ap-note">{note}</p>}
      </div>
      <div className="ap-set-body">{children}</div>
    </section>
  );
}

/**
 * Datakvalitet — what in the journal the analyses can't fully trust. Each row
 * links into the bets list filtered to exactly those rows, so a count is always
 * one click from the bets behind it.
 */
function DataQualitySection() {
  const { data } = useMetrics();
  const dq = data?.dataQuality;
  if (!dq) return null;

  const rows: { flag: QualityFlag; count: number }[] = [
    { flag: "stale-pending", count: dq["stale-pending"] },
    { flag: "dupe", count: dq.dupe },
    { flag: "placeholder", count: dq.placeholder },
    { flag: "no-league", count: dq["no-league"] },
    { flag: "no-category", count: dq["no-category"] },
  ];

  return (
    <Section
      title="Datakvalitet"
      note={`${dq.flagged.toLocaleString("sv-SE")} av ${dq.total.toLocaleString("sv-SE")} spel har en anmärkning. Varje rad leder till just de spelen.`}
    >
      <div>
        {rows.map((r) => (
          <div key={r.flag} className="ap-legrow">
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className={r.count > 0 ? undefined : "ap-t-dim"}>{QUALITY_FLAG_LABELS[r.flag]}</span>
              <small className="ap-set-hint">{QUALITY_FLAG_HINTS[r.flag]}</small>
            </span>
            {r.count > 0 ? (
              <Link href={`/bets?flag=${r.flag}`} className="ap-link ap-num">
                {r.count.toLocaleString("sv-SE")} →
              </Link>
            ) : (
              <span className="ap-num pos">0</span>
            )}
          </div>
        ))}
        {dq.fabricated > 0 && (
          <div className="ap-legrow">
            <span style={{ flex: 1, minWidth: 0 }}>
              Fabricerade spel (märkta {FABRICATED_TAG})
              <small className="ap-set-hint">
                Riktiga rader i databasen som flyttar totalerna — sök på taggen i anteckningarna för att hitta dem.
              </small>
            </span>
            <span className="ap-num neg">{dq.fabricated.toLocaleString("sv-SE")}</span>
          </div>
        )}
      </div>
    </Section>
  );
}
