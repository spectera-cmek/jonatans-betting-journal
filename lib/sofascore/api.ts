// Sofascores öppna JSON (samma som sofascore.com själv läser). Inte ett
// officiellt API: odokumenterat, kan ändras utan förvarning och villkoren
// tillåter inte skrapning. Därför: låg takt, allt cachat, bara personligt bruk.
//
// Hämtas via Scrapling (lib/sofascore/client.ts) och tolkas i
// lib/sofascore/parse.ts. Sökvägarna nedan är relativa API-basen och
// används också som cachenycklar.

/**
 * Samma API på två adresser. Webbplatsen själv läser från www-adressen;
 * api.-adressen spärrar fler klienter. Klienten provar dem i den här
 * ordningen. SOFASCORE_API_BASE tvingar en enda.
 */
export const SOFASCORE_API_BASES = process.env.SOFASCORE_API_BASE
  ? [process.env.SOFASCORE_API_BASE.replace(/\/+$/, "")]
  : ["https://www.sofascore.com/api/v1", "https://api.sofascore.com/api/v1"];

export const SOFASCORE_SITE = "https://www.sofascore.com/";

export type SofaSport = "football" | "basketball" | "ice-hockey";

export const sofaPaths = {
  /** Alla matcher en dag (UTC-datum, YYYY-MM-DD). */
  scheduledEvents: (sport: SofaSport, date: string) => `/sport/${sport}/scheduled-events/${date}`,
  seasons: (uniqueTournamentId: number) => `/unique-tournament/${uniqueTournamentId}/seasons`,
  /** "last" = spelade (sida 0 är den senaste), "next" = kommande. */
  seasonEvents: (uniqueTournamentId: number, seasonId: number, dir: "last" | "next", page: number) =>
    `/unique-tournament/${uniqueTournamentId}/season/${seasonId}/events/${dir}/${page}`,
  event: (id: number) => `/event/${id}`,
  statistics: (id: number) => `/event/${id}/statistics`,
  lineups: (id: number) => `/event/${id}/lineups`,
};

/** Bet-loggens sport → Sofascores. Null för sporter vi inte hämtar. */
export function sofaSportFor(sport: string | null | undefined): SofaSport | null {
  switch ((sport ?? "").trim().toLowerCase()) {
    case "football":
    case "soccer":
    case "fotboll":
      return "football";
    case "basketball":
    case "basket":
      return "basketball";
    case "ice hockey":
    case "ice-hockey":
    case "hockey":
    case "ishockey":
      return "ice-hockey";
    default:
      return null;
  }
}

/** UTC-datumet för en tidpunkt, i formatet scheduled-events vill ha. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
