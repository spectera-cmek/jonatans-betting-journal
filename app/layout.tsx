import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
// Order matters: Tailwind's reset first, then the app's own layers.
import "./globals.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/tables.css";
import "./styles/forms.css";
import "./styles/charts.css";
import "./styles/pages/dashboard.css";
import "./styles/pages/bets.css";
import "./styles/pages/calendar.css";
import "./styles/pages/queue.css";
import "./styles/pages/skott.css";
import "./styles/pages/vm.css";
import "./styles/pages/cs2.css";
import "./styles/pages/nba.css";
import "./styles/pages/settings.css";
import "./styles/pages/auth.css";
import "./styles/motion.css";
import "./styles/a11y.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_COLOR } from "@/lib/theme";

// One superfamily, self-hosted and preloaded: Sans for prose, Sans Condensed
// (set in caps) for headings and labels, Mono for every number.
// The woff2 files (Google Fonts' latin subset, OFL — see app/fonts/) live in the
// repo so the build never fetches from Google: Vercel's build machine got font
// URLs next/font/google couldn't parse and failed an uncached build (2026-11-20).
const sans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});
const disp = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-condensed-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-condensed-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ibm-plex-sans-condensed-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-disp",
  display: "swap",
  fallback: ["Arial Narrow", "system-ui", "sans-serif"],
});
const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-mono-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

export const metadata: Metadata = {
  title: "Betting Översikt",
  description: "Personlig betting-översikt — bets, ROI och form, med auto-rättning från kontoutdrag.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Översikt",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: THEME_COLOR.dark,
};

// Applies the stored preferences to <html> before first paint, so the app can
// render its real content immediately instead of holding everything back until
// React has hydrated: the colour mode, and whether the side panel is folded to
// its icon rail. Storage keys are the ones ThemeProvider and Shell use.
const THEME_INIT = `(function(){try{
var d=document.documentElement,s=window.localStorage;
d.setAttribute("data-mode",s.getItem("bj.mode")==="light"?"light":"dark");
if(s.getItem("bj.nav")==="rail")d.setAttribute("data-nav","rail");
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="sv"
      className={`${sans.variable} ${disp.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
