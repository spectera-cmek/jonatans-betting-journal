// Matchens miljö för en spelares props, ur lagratingen: hur mycket snabbare
// matchen går än lagets vanliga matcher och hur mycket lättare/svårare det är
// att göra poäng mot just den här motståndaren.

import type { PropEnv } from "./props";
import { ratingOf, type RatingTable } from "./teamRatings";

export function propEnv(rt: RatingTable | null | undefined, teamId: number, oppId: number): PropEnv {
  if (!rt || !rt.teams.size) return { paceFactor: 1, effLogit: 0, astFactor: 1 };
  const t = ratingOf(rt, teamId);
  const o = ratingOf(rt, oppId);
  // Tempo: matchens förväntade tempo mot lagets tempo mot ett snittlag.
  const paceFactor = (rt.pace + t.pace + o.pace) / Math.max(80, rt.pace + t.pace);
  // Motståndets försvar: ORtg mot motståndaren / ORtg mot snittet.
  const ratio = (rt.ortg + t.off + o.def) / Math.max(90, rt.ortg + t.off);
  // Poäng per possession ∝ träffprocent kring 50 % ⇒ d(logit) ≈ 2 · relativ ändring.
  return { paceFactor, effLogit: 2 * (ratio - 1), astFactor: ratio };
}
