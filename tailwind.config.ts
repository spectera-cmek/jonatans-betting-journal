import type { Config } from "tailwindcss";

// The app is themed entirely through CSS custom properties — the tokens in
// app/styles/tokens.css, switched via [data-mode]. Tailwind is kept only for its
// reset and utility classes; colours live in those CSS vars, not here, so there
// is a single source of truth for the palette.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Mirror --sans / --mono in app/styles/tokens.css so Tailwind never diverges.
        sans: ["var(--font-sans)", "IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
