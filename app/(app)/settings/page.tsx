"use client";

import { useEffect, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { SyncButton } from "@/components/SyncButton";
import { ImportPanel } from "@/components/ImportPanel";
import { api } from "@/lib/fetcher";
import type { SettingsDTO } from "@/lib/types";
import { I, IC } from "@/components/icons";
import { useTheme } from "@/components/ThemeProvider";
import { ACCENTS } from "@/lib/theme";

export default function SettingsPage() {
  const { accent, mode, glow, setAccent, setMode, setGlow } = useTheme();
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [unitValue, setUnitValue] = useState("100");
  const [currency, setCurrency] = useState("kr");
  const [dailyBudget, setDailyBudget] = useState("");
  const [weeklyBudget, setWeeklyBudget] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<SettingsDTO>("/api/settings").then((s) => {
      setSettings(s);
      setUnitValue(String(s.unitValue));
      setCurrency(s.currency);
      setDailyBudget(s.dailyStakeBudgetUnits != null ? String(s.dailyStakeBudgetUnits) : "");
      setWeeklyBudget(s.weeklyStakeBudgetUnits != null ? String(s.weeklyStakeBudgetUnits) : "");
    });
  }, []);

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
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Topbar title="Inställningar" sub="Enhetsvärde, valuta och synkronisering" icon={<I p={IC.gear} />} />

      <div style={{ maxWidth: 620 }}>
        <Card>
          <span className="ap-label">Utseende</span>
          <p style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 12, marginBottom: 16, lineHeight: 1.55 }}>
            Editorial sportsbook använder en mörk grafitbas och blå accent. Grönt och rött är reserverat för resultat.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 8 }}>Accentfärg</div>
              <div className="ap-swatches">
                {ACCENTS.map((a) => (
                  <button
                    key={a.key}
                    className={"ap-swatch" + (accent.hex === a.hex ? " is-active" : "")}
                    style={{ background: a.hex }}
                    title={a.label}
                    aria-label={`Välj ${a.label}`}
                    onClick={() => setAccent(a.hex)}
                  />
                ))}
              </div>
            </div>
            <div className="ap-toggle">
              <span>Mörkt läge</span>
              <button
                className={"ap-switch" + (mode === "dark" ? " on" : "")}
                onClick={() => setMode(mode === "dark" ? "light" : "dark")}
                aria-label="Växla mörkt läge"
              />
            </div>
            <div className="ap-toggle">
              <span>Bakgrundsglöd</span>
              <button
                className={"ap-switch" + (glow ? " on" : "")}
                onClick={() => setGlow(!glow)}
                aria-label="Växla glöd"
              />
            </div>
          </div>
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Konfiguration</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
            <div className="ap-field">
              <label>Enhetsvärde (valuta per 1U)</label>
              <input className="ap-input ap-num" type="number" value={unitValue} onChange={(e) => setUnitValue(e.target.value)} />
            </div>
            <div className="ap-field">
              <label>Valuta</label>
              <input className="ap-input" value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button className="ap-btn" onClick={save} disabled={saving}>{saving ? "Sparar…" : "Spara"}</button>
              {saved && <span className="pos" style={{ fontSize: 13 }}>✓ Sparat</span>}
            </div>
          </div>
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Tilt-vakt</span>
          <p style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 14, marginBottom: 14, lineHeight: 1.55 }}>
            Sätt ett tak för hur många units du satsar per dag och vecka. När du närmar dig taket — eller när
            insatserna ökar under en förlustsvit — visas en varning på översikten. Lämna tomt för att stänga av.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="ap-x2">
              <div className="ap-field">
                <label>Dagsbudget (U)</label>
                <input className="ap-input ap-num" type="number" min="0" placeholder="av" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
              </div>
              <div className="ap-field">
                <label>Veckobudget (U)</label>
                <input className="ap-input ap-num" type="number" min="0" placeholder="av" value={weeklyBudget} onChange={(e) => setWeeklyBudget(e.target.value)} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button className="ap-btn" onClick={save} disabled={saving}>{saving ? "Sparar…" : "Spara"}</button>
              {saved && <span className="pos" style={{ fontSize: 13 }}>✓ Sparat</span>}
            </div>
          </div>
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Auto-rättning från kontoutdrag (Bet365)</span>
          <div style={{ marginTop: 14 }}>
            <ImportPanel />
          </div>
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Rätta via resultat (gratis)</span>
          <p style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 14, marginBottom: 14, lineHeight: 1.55 }}>
            Rättar öppna <strong style={{ color: "var(--txt)" }}>singel-bets</strong> (1X2, över/under, handikapp) på
            NBA, NHL, MLB, NFL och stora fotbollsligor via slutresultat — helt utan API-nyckel. Ackumulatorer och
            special-marknader rättas via kontoutdraget ovan.
          </p>
          <SyncButton kind="scores" label="Rätta via resultat" showResult />
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Resultat-API (valfritt)</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 14 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: settings?.hasOddsApiKey ? "var(--pos)" : "var(--red)" }} />
            <span>The Odds API: {settings?.hasOddsApiKey ? <span className="pos">ansluten</span> : <span className="neg">ingen nyckel</span>}</span>
          </div>

          {settings?.hasOddsApiKey ? (
            <div style={{ marginTop: 14 }}>
              <p style={{ fontSize: 13, color: "var(--dim)", marginBottom: 12 }}>
                Synka för att auto-rätta färdigspelade bets och fånga stängningsodds (CLV). Bets måste vara länkade via &quot;Sök event&quot;.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <SyncButton kind="grade" label="Rätta resultat" />
                <SyncButton kind="closing" label="Hämta closing-odds" />
                <SyncButton kind="all" label="Full synk" />
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 14, fontSize: 13, color: "var(--dim)" }}>
              <p style={{ marginBottom: 8 }}>Lägg till en gratis nyckel för auto-rättning + CLV:</p>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4, color: "var(--dim2)" }}>
                <li>Skapa gratis nyckel på <span style={{ color: "var(--acc)" }}>the-odds-api.com</span> (~500 anrop/mån).</li>
                <li>Skapa <code style={{ color: "var(--pos)" }}>.env.local</code> i projektmappen.</li>
                <li>Lägg in <code style={{ color: "var(--pos)" }}>ODDS_API_KEY=din_nyckel</code>.</li>
                <li>Starta om servern.</li>
              </ol>
              <p style={{ marginTop: 8, color: "var(--dim2)" }}>Tills dess fungerar allt manuellt — rätta bets med W/L-knapparna.</p>
            </div>
          )}
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Data</span>
          <div style={{ marginTop: 14 }}>
            <a className="ap-btn ghost" href="/api/bets/export"><I p={IC.download} size={15} /> Exportera alla bets (CSV)</a>
          </div>
        </Card>

        <div style={{ height: 12 }} />

        <Card>
          <span className="ap-label">Konto</span>
          {settings?.username && (
            <p style={{ fontSize: 13, color: "var(--dim)", marginTop: 14, marginBottom: 0 }}>
              Inloggad som <strong style={{ color: "var(--txt)" }}>{settings.username}</strong>
            </p>
          )}
          <div style={{ marginTop: 14 }}>
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
        </Card>
      </div>
    </div>
  );
}
