import { describe, expect, it } from "vitest";
import {
  findWorldCupMatchForBet,
  findWorldCupMatchesForBet,
  type WorldCupMatch,
} from "../lib/worldCup";

const norwayEngland: WorldCupMatch = {
  id: "760512",
  startsAt: "2026-07-11T21:00:00.000Z",
  stage: "quarterfinal",
  stageLabel: "Kvartsfinal",
  group: null,
  status: "scheduled",
  statusText: "Scheduled",
  completed: false,
  home: { id: "1", name: "Norway", abbreviation: "NOR", logo: null },
  away: { id: "2", name: "England", abbreviation: "ENG", logo: null },
  homeScore: null,
  awayScore: null,
  venue: "Hard Rock Stadium",
  wentToExtraTime: false,
};

const argentinaSwitzerland: WorldCupMatch = {
  id: "760513",
  startsAt: "2026-07-12T01:00:00.000Z",
  stage: "quarterfinal",
  stageLabel: "Kvartsfinal",
  group: null,
  status: "scheduled",
  statusText: "Scheduled",
  completed: false,
  home: { id: "3", name: "Argentina", abbreviation: "ARG", logo: null },
  away: { id: "4", name: "Switzerland", abbreviation: "SUI", logo: null },
  homeScore: null,
  awayScore: null,
  venue: "Arrowhead",
  wentToExtraTime: false,
};

const franceSpain: WorldCupMatch = {
  id: "760514",
  startsAt: "2026-07-14T19:00:00.000Z",
  stage: "semifinal",
  stageLabel: "Semifinal",
  group: null,
  status: "scheduled",
  statusText: "Scheduled",
  completed: false,
  home: { id: "5", name: "France", abbreviation: "FRA", logo: null },
  away: { id: "6", name: "Spain", abbreviation: "ESP", logo: null },
  homeScore: null,
  awayScore: null,
  venue: "AT&T Stadium",
  wentToExtraTime: false,
};

const matches = [norwayEngland, argentinaSwitzerland, franceSpain];

describe("findWorldCupMatchesForBet", () => {
  it("links Swedish team names from event text", () => {
    const linked = findWorldCupMatchesForBet(
      {
        event: "Norge v England",
        selection: "England - Slutresultat (1X2)",
        eventAt: "2026-07-11T21:00:00.000Z",
        eventKind: "match",
      },
      matches
    );
    expect(linked.map((match) => match.id)).toEqual(["760512"]);
  });

  it("links Swedish home/away fields", () => {
    const linked = findWorldCupMatchesForBet(
      {
        event: "Argentina vs Schweiz",
        selection: "Messi foul",
        homeTeam: "Argentina",
        awayTeam: "Schweiz",
        eventAt: "2026-07-12T01:00:00.000Z",
        eventKind: "match",
      },
      matches
    );
    expect(linked.map((match) => match.id)).toEqual(["760513"]);
  });

  it("links Frankrike vs Spanien", () => {
    const linked = findWorldCupMatchesForBet(
      {
        event: "Frankrike vs Spanien",
        selection: "Mbappé skott",
        homeTeam: "Frankrike",
        awayTeam: "Spanien",
        eventAt: "2026-07-14T19:00:00.000Z",
        eventKind: "match",
      },
      matches
    );
    expect(linked.map((match) => match.id)).toEqual(["760514"]);
  });

  it("links combo bets to multiple fixtures", () => {
    const linked = findWorldCupMatchesForBet(
      {
        event: "Norge–England + Spanien–Belgien",
        selection: "England + Spanien",
        eventAt: "2026-07-11T21:00:00.000Z",
        eventKind: "match",
      },
      matches
    );
    expect(linked.map((match) => match.id)).toContain("760512");
  });

  it("skips outright tournament bets", () => {
    const linked = findWorldCupMatchesForBet(
      {
        event: "VM 2026 Turneringsspel",
        selection: "Spanien vinner VM",
        eventKind: "outright",
      },
      matches
    );
    expect(linked).toEqual([]);
  });

  it("returns a single match for grading when unambiguous", () => {
    const match = findWorldCupMatchForBet(
      {
        event: "Norge v England",
        selection: "Över 2.5 mål",
        eventAt: "2026-07-11T21:00:00.000Z",
        eventKind: "match",
      },
      matches
    );
    expect(match?.id).toBe("760512");
  });
});
