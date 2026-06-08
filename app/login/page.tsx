"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Inloggningen misslyckades.");
        return;
      }
      // Honour ?next=… so deep links survive the redirect.
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") ? next : "/";
    } catch {
      setError("Nätverksfel — försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ap-login">
      <form className="ap-login-card" onSubmit={submit}>
        <div className="ap-login-logo">
          <div className="mark">J</div>
        </div>
        <h1 className="ap-login-title">Jonatans Betting Journal</h1>
        <p className="ap-login-sub">Ange lösenord för att fortsätta</p>

        <input
          className="ap-input"
          type="password"
          inputMode="text"
          autoComplete="current-password"
          placeholder="Lösenord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          style={{ marginTop: 18, width: "100%" }}
        />

        {error && <div className="ap-login-err">{error}</div>}

        <button className="ap-btn" type="submit" disabled={busy} style={{ marginTop: 14, width: "100%", justifyContent: "center" }}>
          {busy ? "Loggar in…" : "Logga in"}
        </button>
      </form>
    </div>
  );
}
