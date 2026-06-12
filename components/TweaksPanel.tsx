"use client";

import { useState } from "react";
import { useTheme } from "./ThemeProvider";
import { ACCENTS } from "@/lib/theme";
import { I, IC } from "./icons";

export function TweaksPanel() {
  const [open, setOpen] = useState(false);
  const { accent, mode, glow, setAccent, setMode, setGlow } = useTheme();

  return (
    <div className="ap-tweaks">
      {open && (
        <div className="ap-tweaks-panel">
          <span className="ap-label">Tema</span>
          <div>
            <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 8 }}>Accentfärg</div>
            <div className="ap-swatches">
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  className={"ap-swatch" + (accent.hex === a.hex ? " is-active" : "")}
                  style={{ background: a.hex }}
                  title={a.label}
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
      )}
      <button className="ap-tweaks-fab" onClick={() => setOpen((o) => !o)} aria-label="Tema">
        <I p={open ? IC.x : IC.gear} size={19} />
      </button>
    </div>
  );
}
