// Delade typer för CS2-modulen. Rena typer — inga beroenden — så både
// skript, API-rutter och klientkomponenter kan importera härifrån.

export type Side = "ct" | "t";
export type SeriesFormat = "bo1" | "bo3" | "bo5";
export type MatchStatus = "scheduled" | "live" | "finished" | "cancelled";

/** Hur en runda slutade, ur HLTV:s rundhistorik eller demon. */
export type RoundEndReason =
  | "elimination" // alla i motståndarlaget döda
  | "bomb_exploded"
  | "bomb_defused"
  | "time" // tiden tog slut (CT vinner)
  | "unknown";

/** En runda ur kartans perspektiv. `winner` avser kartans team1/team2. */
export interface RoundOutcome {
  /** 1-baserat rundnummer. */
  n: number;
  winner: "team1" | "team2";
  /** Sidan vinnaren spelade på. */
  side: Side;
  reason: RoundEndReason;
}

/** Marknaderna modellen prissätter. Lagras som sträng i Cs2Line/Cs2Projection. */
export type Cs2Market =
  | "kills" // spelarens kills
  | "headshots" // spelarens headshots
  | "rounds" // totala rundor på en karta
  | "map_handicap" // rundhandikapp på en karta (line = team1:s handikapp)
  | "map_winner" // vinnare av en karta
  | "match_winner"
  | "match_handicap" // karthandikapp (line = team1:s handikapp, t.ex. -1.5)
  | "total_maps" // antal kartor (Ö/U 2.5)
  | "pistol" // vinnare av första pistolrundan på en karta
  | "first_kill" // laget som tar kartans första kill
  | "player_first_kill"; // spelaren som tar kartans första kill (ja/nej)

export type Cs2Scope = "map1" | "map2" | "map3" | "maps12" | "match";

export const CS2_MARKET_LABEL: Record<Cs2Market, string> = {
  kills: "Kills",
  headshots: "Headshots",
  rounds: "Totala rundor",
  map_handicap: "Rundhandikapp",
  map_winner: "Kartvinnare",
  match_winner: "Matchvinnare",
  match_handicap: "Karthandikapp",
  total_maps: "Antal kartor",
  pistol: "Pistolrunda",
  first_kill: "Första kill (lag)",
  player_first_kill: "Första kill (spelare)",
};

export const CS2_SCOPE_LABEL: Record<Cs2Scope, string> = {
  map1: "Karta 1",
  map2: "Karta 2",
  map3: "Karta 3",
  maps12: "Karta 1–2",
  match: "Matchen",
};

/** Marknader som gäller en spelare (kräver playerId). */
export const PLAYER_MARKETS: ReadonlySet<Cs2Market> = new Set(["kills", "headshots", "player_first_kill"]);

/** Marknader med en Ö/U-linje (övriga är tvåvägs utan linje eller handikapp). */
export const TOTAL_MARKETS: ReadonlySet<Cs2Market> = new Set(["kills", "headshots", "rounds", "total_maps"]);
