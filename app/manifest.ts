import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest — makes the app installable on a phone
// home screen ("Lägg till på hemskärmen") so it launches like a native app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jonatans Betting Journal",
    short_name: "Journal",
    description: "Personlig betting-journal — bets, ROI och form.",
    lang: "sv",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0d14",
    theme_color: "#0b0d14",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
