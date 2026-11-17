"use client";

import { useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== passwordConfirm) {
      setError("Lösenorden matchar inte.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, passwordConfirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Det gick inte att byta lösenord.");
        return;
      }
      window.location.href = "/";
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
          <div className="mark">
            <BrandMark size={26} />
          </div>
        </div>
        <h1 className="ap-login-title">Nytt lösenord</h1>
        {token ? (
          <>
            <p className="ap-login-sub">Länken gäller en gång. Du loggas in direkt efteråt.</p>
            <input
              className="ap-input"
              type="password"
              autoComplete="new-password"
              placeholder="Nytt lösenord (minst 8 tecken)"
              aria-label="Nytt lösenord (minst 8 tecken)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              style={{ marginTop: 18, width: "100%" }}
            />
            <input
              className="ap-input"
              type="password"
              autoComplete="new-password"
              placeholder="Bekräfta lösenord"
              aria-label="Bekräfta lösenord"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              style={{ marginTop: 10, width: "100%" }}
            />
            {error && <div className="ap-login-err" role="alert">{error}</div>}
            <button className="ap-btn" type="submit" disabled={busy} style={{ marginTop: 14, width: "100%", justifyContent: "center" }}>
              {busy ? "Sparar…" : "Spara och logga in"}
            </button>
          </>
        ) : (
          <p className="ap-login-err" role="alert">Länken saknar sin kod. Öppna hela länken du fick, eller be om en ny.</p>
        )}
        <p className="ap-login-sub" style={{ marginTop: 14 }}>
          <Link href="/login" className="ap-link" style={{ fontSize: "inherit" }}>Till inloggningen</Link>
        </p>
      </form>
    </div>
  );
}
