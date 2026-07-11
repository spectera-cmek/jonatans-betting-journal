// Safe structured-tag backfill.
//
//   npx tsx scripts/backfillBetTags.ts
//   npx tsx scripts/backfillBetTags.ts --sample 25
//   npx tsx scripts/backfillBetTags.ts --confirm
//
// Dry-run is the default. Confirmed runs back up every affected row before
// writing and never replace a non-empty manual league/category with a guess.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { categorizeBet, type LegLike } from "../lib/categorize";
import {
  EVENT_KINDS,
  MARKET_SCOPES,
  VM_2026_LEAGUE,
  inferEventKind,
  inferTournamentStage,
  isWorldCup2026Text,
  normalizeGradingMarket,
  normalizeLeague,
  normalizeMarketCategory,
  normalizeTournamentStage,
} from "../lib/betTaxonomy";
import { fetchWorldCupData, findWorldCupMatchForBet } from "../lib/worldCup";

const BACKUP_DIR = ".claude/backups";

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const sampleIndex = args.indexOf("--sample");
  const sampleN = sampleIndex >= 0 ? Number(args[sampleIndex + 1]) || 20 : 20;
  const prisma = new PrismaClient();

  try {
    const bets = await prisma.bet.findMany({
      select: {
        id: true,
        event: true,
        selection: true,
        sport: true,
        league: true,
        market: true,
        marketCategory: true,
        marketScope: true,
        selectionSide: true,
        eventKind: true,
        tournamentStage: true,
        resultProvider: true,
        resultEventRef: true,
        eventAt: true,
        homeTeam: true,
        awayTeam: true,
        notes: true,
        legs: true,
      },
    });
    const worldCup = await fetchWorldCupData();

    const changes: {
      id: string;
      before: (typeof bets)[number];
      data: Record<string, unknown>;
      reasons: string[];
    }[] = [];
    const unknownCategories = new Map<string, number>();

    for (const bet of bets) {
      let legs: LegLike[] = [];
      try {
        const parsed = JSON.parse(bet.legs || "[]");
        if (Array.isArray(parsed)) legs = parsed;
      } catch {
        // Keep malformed legacy leg JSON untouched; the other fields are enough.
      }

      const inferred = categorizeBet(bet.event, legs);
      const matchedWorldCup =
        bet.eventKind !== "outright"
          ? findWorldCupMatchForBet(bet, worldCup.matches)
          : null;
      const data: Record<string, unknown> = {};
      const reasons: string[] = [];

      if (!bet.sport || bet.sport === "Other") {
        if (inferred.sport !== "Other" && inferred.sport !== bet.sport) {
          data.sport = inferred.sport;
          reasons.push("sport");
        }
      }

      const normalizedLeague = normalizeLeague(bet.league);
      const vmText = `${bet.event} ${bet.selection} ${bet.notes ?? ""}`;
      const inferredLeague =
        normalizedLeague ??
        (isWorldCup2026Text(vmText) || matchedWorldCup
          ? VM_2026_LEAGUE
          : inferred.league);
      if (!same(bet.league, inferredLeague) && (!bet.league || normalizedLeague === VM_2026_LEAGUE)) {
        data.league = inferredLeague;
        reasons.push("league");
      }

      let category = bet.marketCategory;
      if (category) {
        const normalized = normalizeMarketCategory(category);
        if (normalized !== "Övrigt" || category.trim().toLocaleLowerCase("sv-SE") === "övrigt") {
          category = normalized;
        } else {
          unknownCategories.set(category, (unknownCategories.get(category) ?? 0) + 1);
        }
      } else {
        const legacyCategory = normalizeMarketCategory(bet.market);
        category = legacyCategory !== "Övrigt" ? legacyCategory : inferred.marketCategory;
      }
      if (!same(bet.marketCategory, category)) {
        data.marketCategory = category;
        reasons.push("marketCategory");
      }

      const market = normalizeGradingMarket(bet.market, category, bet.selectionSide);
      if (market !== bet.market) {
        data.market = market;
        reasons.push("market");
      }

      let scope = bet.marketScope;
      if (!scope || !MARKET_SCOPES.includes(scope as (typeof MARKET_SCOPES)[number])) {
        scope = inferred.marketScope;
      }
      if (!same(bet.marketScope, scope)) {
        data.marketScope = scope;
        reasons.push("marketScope");
      }

      const inferredKind = inferEventKind(bet.event, bet.selection);
      const kind = EVENT_KINDS.includes(bet.eventKind as (typeof EVENT_KINDS)[number])
        ? bet.eventKind === "match" && inferredKind === "outright"
          ? inferredKind
          : bet.eventKind
        : inferredKind;
      if (kind !== bet.eventKind) {
        data.eventKind = kind;
        reasons.push("eventKind");
      }

      const stage =
        normalizeTournamentStage(bet.tournamentStage) ??
        matchedWorldCup?.stage ??
        (inferredLeague === VM_2026_LEAGUE
          ? inferTournamentStage(`${bet.event} ${bet.selection} ${bet.notes ?? ""}`)
          : null);
      if (!same(bet.tournamentStage, stage)) {
        data.tournamentStage = stage;
        reasons.push("tournamentStage");
      }

      if (matchedWorldCup && (!bet.league || normalizedLeague === VM_2026_LEAGUE)) {
        if (bet.resultProvider !== "espn") {
          data.resultProvider = "espn";
          reasons.push("resultProvider");
        }
        if (bet.resultEventRef !== matchedWorldCup.id) {
          data.resultEventRef = matchedWorldCup.id;
          reasons.push("resultEventRef");
        }
        if (!bet.homeTeam) {
          data.homeTeam = matchedWorldCup.home.name;
          reasons.push("homeTeam");
        }
        if (!bet.awayTeam) {
          data.awayTeam = matchedWorldCup.away.name;
          reasons.push("awayTeam");
        }
      }

      if (reasons.length) changes.push({ id: bet.id, before: bet, data, reasons });
    }

    console.log(`Loaded ${bets.length} bets; ${changes.length} need structured-tag updates.`);
    for (const change of changes.slice(0, sampleN)) {
      console.log(
        `${change.id}  ${change.reasons.join(", ")}  ${change.before.event} — ${change.before.selection}`
      );
    }
    if (changes.length > sampleN) console.log(`... and ${changes.length - sampleN} more.`);

    if (unknownCategories.size) {
      console.log("\nManual categories preserved (no safe canonical alias):");
      for (const [category, count] of [...unknownCategories].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${count}  ${category}`);
      }
    }

    if (!confirm) {
      console.log("\nDRY RUN — nothing written. Re-run with --confirm after reviewing this report.");
      return;
    }
    if (!changes.length) {
      console.log("Nothing to update.");
      return;
    }

    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${BACKUP_DIR}/bet-tags-before-${stamp}.json`;
    writeFileSync(backupPath, JSON.stringify(changes.map((change) => change.before), null, 2));
    console.log(`Backup: ${backupPath}`);

    let updated = 0;
    for (const change of changes) {
      await prisma.bet.update({ where: { id: change.id }, data: change.data });
      updated += 1;
      if (updated % 250 === 0) process.stdout.write(`\rUpdated ${updated}/${changes.length}`);
    }
    console.log(`\rUpdated ${updated}/${changes.length}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
