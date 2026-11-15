import type { MetadataRoute } from "next";
import { THEME_COLOR } from "@/lib/theme";

// Served at /manifest.webmanifest — makes the app installable on a phone
// home screen ("Lägg till på hemskärmen") so it launches like a native app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Betting Översikt",
    short_name: "Översikt",
    description: "Personlig betting-översikt — bets, ROI och form.",
    lang: "sv",
    start_url: "/",
    display: "standalone",
    // The dark canvas: what the splash screen and the status bar are painted with.
    background_color: THEME_COLOR.dark,
    theme_color: THEME_COLOR.dark,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
