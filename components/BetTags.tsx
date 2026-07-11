"use client";

import { SCOPE_LABELS } from "@/lib/constants";
import {
  TOURNAMENT_STAGE_LABELS,
  VM_2026_LEAGUE,
  type TournamentStage,
} from "@/lib/betTaxonomy";

export interface BetTagLike {
  sport?: string | null;
  league?: string | null;
  marketCategory?: string | null;
  marketScope?: string | null;
  betType?: string | null;
  eventKind?: string | null;
  tournamentStage?: string | null;
}

const SPORT_LABELS: Record<string, string> = {
  Football: "Fotboll",
  Tennis: "Tennis",
  Basketball: "Basket",
  "Ice Hockey": "Ishockey",
  "American Football": "Amerikansk fotboll",
  Baseball: "Baseboll",
  MMA: "MMA",
  Boxing: "Boxning",
  Esports: "Esport",
  "Horse Racing": "Häst",
  Golf: "Golf",
  Cricket: "Cricket",
  Other: "Övrigt",
};

interface Tag {
  key: string;
  label: string;
  title: string;
  tone?: "accent" | "muted";
}

function tagsFor(bet: BetTagLike, compact: boolean): Tag[] {
  const tags: Tag[] = [];
  if (bet.sport) {
    tags.push({
      key: "sport",
      label: SPORT_LABELS[bet.sport] ?? bet.sport,
      title: `Sport: ${SPORT_LABELS[bet.sport] ?? bet.sport}`,
    });
  }
  if (bet.league) {
    tags.push({
      key: "league",
      label: bet.league === VM_2026_LEAGUE ? "VM 2026" : bet.league,
      title: `Liga/turnering: ${bet.league}`,
      tone: bet.league === VM_2026_LEAGUE ? "accent" : undefined,
    });
  }
  if (bet.tournamentStage) {
    const stage =
      TOURNAMENT_STAGE_LABELS[bet.tournamentStage as TournamentStage] ??
      bet.tournamentStage;
    tags.push({ key: "stage", label: stage, title: `Turneringsfas: ${stage}` });
  }
  if (bet.marketCategory) {
    tags.push({
      key: "category",
      label: bet.marketCategory,
      title: `Marknad: ${bet.marketCategory}`,
    });
  }
  if (bet.marketScope) {
    const scope = SCOPE_LABELS[bet.marketScope] ?? bet.marketScope;
    tags.push({ key: "scope", label: scope, title: `Avser: ${scope}`, tone: "muted" });
  }
  if (bet.eventKind === "outright") {
    tags.push({
      key: "eventKind",
      label: "Turneringsspel",
      title: "Speltyp: turneringsspel/future",
      tone: "accent",
    });
  }
  if (bet.betType === "accumulator") {
    tags.push({ key: "betType", label: "Ack", title: "Bettyp: ackumulator" });
  }
  return compact ? tags.slice(0, 4) : tags;
}

export function BetTags({
  bet,
  compact = false,
  hideSport = false,
  className = "",
}: {
  bet: BetTagLike;
  compact?: boolean;
  hideSport?: boolean;
  className?: string;
}) {
  const tags = tagsFor(bet, compact).filter((tag) => !(hideSport && tag.key === "sport"));
  if (!tags.length) return null;

  return (
    <span className={`ap-bet-tags ${className}`.trim()}>
      {tags.map((tag) => (
        <span
          key={tag.key}
          className={`ap-tag${tag.tone === "accent" ? " is-accent" : ""}${tag.tone === "muted" ? " is-muted" : ""}`}
          title={tag.title}
        >
          {tag.label}
        </span>
      ))}
    </span>
  );
}
