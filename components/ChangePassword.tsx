"use client";

import { useState } from "react";
import { Field } from "@/components/ui";
import { api } from "@/lib/fetcher";

/** Byt lösenord i Inställningar. Kräver det nuvarande lösenordet. */
export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError("Lösenorden matchar inte.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/account/password", { currentPassword: current, password: next, passwordConfirm: confirm });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Field label="Nuvarande lösenord">
        <input className="ap-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <div className="ap-x2" style={{ marginTop: 10 }}>
        <Field label="Nytt lösenord (minst 8 tecken)">
          <input className="ap-input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Bekräfta nytt lösenord">
          <input className="ap-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
      <div className="ap-set-actions">
        <button className="ap-btn" type="submit" disabled={busy || !current || !next || !confirm}>
          {busy ? "Byter…" : "Byt lösenord"}
        </button>
        {done && <span className="pos ap-t-md" role="status">✓ Lösenordet är bytt</span>}
        {error && <span className="neg ap-t-md" role="alert">{error}</span>}
      </div>
    </form>
  );
}
