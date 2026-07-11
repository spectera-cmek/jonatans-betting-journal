// Kept as a backwards-compatible command name. The old implementation wrote
// semantic Swedish categories into Bet.market, which is reserved for grading.
// The replacement is dry-run first, backs up confirmed changes and preserves
// non-empty manual metadata.
import "./backfillBetTags";
