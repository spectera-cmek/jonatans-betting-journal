import type { Config } from "tailwindcss";

// Pro terminal dark palette (Bloomberg / pro-bettor vibe)
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        hero: "#020617", // deepest band
        canvas: "#0B1220", // page background
        card: "#111927", // cards (lightest of the three)
        band: "#0F1626", // alternating row tint
        line: {
          DEFAULT: "#1F2A44", // strong dividers
          subtle: "#172033", // subtle dividers
        },
        text: {
          hi: "#F8FAFC",
          mid: "#94A3B8",
          lo: "#64748B",
        },
        pos: "#00D97E", // neon green — wins / profit
        neg: "#FF3D5A", // neon red — losses
        accent: {
          blue: "#3B82F6",
          purple: "#A78BFA",
          amber: "#FBBF24",
        },
        // result-row tints
        rowwin: "#0A2419",
        rowloss: "#260910",
        rowpush: "#1F1505",
        rowvoid: "#1A1F2E",
        rowpending: "#0A1F40",
      },
      fontFamily: {
        sans: ["Inter", "Aptos", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.02), 0 8px 24px -12px rgba(0,0,0,0.6)",
        glow: "0 0 24px -8px rgba(0,217,126,0.4)",
      },
    },
  },
  plugins: [],
};

export default config;
