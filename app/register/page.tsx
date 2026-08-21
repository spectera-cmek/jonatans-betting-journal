"use client";

import { useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/icons";

// Standalone registration screen (outside the (app) layout group, like /login).
// Registration is gated by an invite code so strangers can't sign up on the
// public URL. On success the API sets the session cookie — straight to "/".
export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
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
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, passwordConfirm, inviteCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Registreringen misslyckades.");
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
        <h1 className="ap-login-title">Skapa konto</h1>
        <p className="ap-login-sub">Tracka dina egna bets i översikten</p>

        <input
          className="ap-input"
          type="text"
          inputMode="text"
          autoComplete="username"
          autoCapitalize="none"
          placeholder="Användarnamn (3–20 tecken)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          style={{ marginTop: 18, width: "100%" }}
        />

        <input
          className="ap-input"
          type="password"
          autoComplete="new-password"
          placeholder="Lösenord (minst 8 tecken)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ marginTop: 10, width: "100%" }}
        />

        <input
          className="ap-input"
          type="password"
          autoComplete="new-password"
          placeholder="Bekräfta lösenord"
          value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)}
          style={{ marginTop: 10, width: "100%" }}
        />

        <input
          className="ap-input"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          placeholder="Inbjudningskod"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          style={{ marginTop: 10, width: "100%" }}
        />

        {error && <div className="ap-login-err">{error}</div>}

        <button className="ap-btn" type="submit" disabled={busy} style={{ marginTop: 14, width: "100%", justifyContent: "center" }}>
          {busy ? "Skapar konto…" : "Skapa konto"}
        </button>

        <p className="ap-login-sub" style={{ marginTop: 14 }}>
          Har du redan ett konto? <Link href="/login" style={{ color: "var(--accent, #7aa2ff)" }}>Logga in</Link>
        </p>
      </form>
    </div>
  );
}
