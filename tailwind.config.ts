import type { Config } from "tailwindcss";

// The app is themed entirely through CSS custom properties — the "Aurora" system
// in app/globals.css, switched via [data-mode] and inline --acc vars. Tailwind is
// kept only for base/utility classes; colours and shadows live in those CSS vars,
// not here, so there is a single source of truth for the palette.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Mirror --sans in globals.css so Tailwind's font-sans never diverges.
        sans: ["Hanken Grotesk", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
