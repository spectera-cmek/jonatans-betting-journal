// Syntetisk CS2-match i demoparser2:s radformat — delas av demo- och
// gameplan-testerna. 13 rundor: A är CT i första halvlek, B vinner runda 13.
import { buildRounds, sampleTicksFor } from "../../lib/cs2/demo/parseDemo";
import type { RawDemo, RawRow } from "../../lib/cs2/demo/types";

// ---------------------------------------------------------------------------
// Syntetisk match i demoparser2:s radformat
// ---------------------------------------------------------------------------

export const TR = 64;
export const A = ["a1", "a2", "a3", "a4", "a5"]; // CT i första halvlek
export const B = ["b1", "b2", "b3", "b4", "b5"];
// Vinnare per runda (lag), 13 rundor: runda 13 = andra halvlekens pistol.
export const WINNERS = ["B", "A", "A", "B", "A", "A", "A", "B", "A", "A", "B", "A", "B"] as const;

function sideOf(team: "A" | "B", n: number): 2 | 3 {
  const aCt = n <= 12;
  return (team === "A") === aCt ? 3 : 2;
}

export function roundTicks(n: number) {
  const start = 1000 + (n - 1) * 10_000;
  return { start, freezeEnd: start + 15 * TR, end: start + 15 * TR + 80 * TR };
}

export function buildEvents(): RawRow[] {
  const ev: RawRow[] = [];
  // Uppvärmning och knivrunda före matchstart ska bort.
  ev.push({ event_name: "round_end", tick: 200, winner: "CT", reason: 9, is_warmup_period: true });
  ev.push({ event_name: "round_end", tick: 600, winner: "T", reason: 8 });
  ev.push({ event_name: "round_announce_match_start", tick: 900 });
  WINNERS.forEach((w, i) => {
    const n = i + 1;
    const t = roundTicks(n);
    ev.push({ event_name: "round_start", tick: t.start });
    ev.push({ event_name: "round_freeze_end", tick: t.freezeEnd });
    const winTeam = w === "A" ? A : B;
    const loseTeam = w === "A" ? B : A;
    const winSide = sideOf(w, n) === 3 ? "CT" : "T";
    if (n === 7) {
      // Clutch: B tar fyra kills först, sedan vinner a5 1v5.
      for (let k = 0; k < 4; k++)
        ev.push(death(t.freezeEnd + (8 + k) * TR, B[k], A[k], "ak47", k === 0));
      for (let k = 0; k < 5; k++) ev.push(death(t.freezeEnd + (20 + k) * TR, "a5", B[k], "m4a1", false));
    } else {
      // Vinnarlaget tar alla fem; första killen vid 8 s.
      for (let k = 0; k < 5; k++) {
        const killer = winTeam[(n + k) % 5];
        const weapon = n === 2 && k === 0 ? "awp" : "ak47";
        ev.push(death(t.freezeEnd + (8 + k * 3) * TR, killer, loseTeam[k], weapon, k % 2 === 0));
      }
    }
    if (n === 1) {
      ev.push({ event_name: "bomb_planted", tick: t.freezeEnd + 30 * TR, user_steamid: "b2", user_last_place_name: "BombsiteA", user_X: 1000, user_Y: 1000 });
      ev.push({ event_name: "player_hurt", tick: t.freezeEnd + 5 * TR, attacker_steamid: "b3", user_steamid: "a2", weapon: "hegrenade", dmg_health: 40 });
    }
    if (n === 3) ev.push({ event_name: "bomb_planted", tick: t.freezeEnd + 40 * TR, user_steamid: "b1", user_last_place_name: "BombsiteB", user_X: -1000, user_Y: -1000 });
    ev.push({ event_name: "round_end", tick: t.end, winner: winSide, reason: 99 });
  });
  return ev;

  function death(tick: number, attacker: string, victim: string, weapon: string, headshot: boolean): RawRow {
    return {
      event_name: "player_death",
      tick,
      attacker_steamid: attacker,
      attacker_name: attacker.toUpperCase(),
      user_steamid: victim,
      user_name: victim.toUpperCase(),
      weapon,
      headshot,
      assister_steamid: null,
      assistedflash: false,
      attacker_last_place_name: "Middle",
      user_last_place_name: "Middle",
    };
  }
}

const CT_SPOTS: Record<string, [string, number, number]> = {
  a1: ["BombsiteA", 1000, 1000],
  a2: ["BombsiteA", 1050, 1000],
  a3: ["Connector", 0, 0],
  a4: ["BombsiteB", -1000, -1000],
  a5: ["BombsiteB", -1050, -1000],
};

export function buildRaw(): RawDemo {
  const events = buildEvents();
  const rounds = buildRounds(events);
  const sampleTicks = sampleTicksFor(rounds);
  const samples: RawRow[] = [];
  for (const st of sampleTicks) {
    for (const id of [...A, ...B]) {
      const team = A.includes(id) ? "A" : "B";
      const side = sideOf(team, st.round);
      let equip = 4500;
      if (st.round === 1 || st.round === 13) equip = 800;
      if (st.round === 2) equip = team === "A" ? 800 : 3000;
      const isCtA = side === 3 && team === "A";
      const [place, x, y] = isCtA ? CT_SPOTS[id] : ["TSpawn", id === "b5" ? 5000 : 0, 0];
      samples.push({
        tick: st.tick,
        steamid: id,
        name: id.toUpperCase(),
        team_num: side,
        X: x,
        Y: y,
        Z: 0,
        last_place_name: place,
        is_alive: true,
        current_equip_value: equip,
        inventory: id === "a1" ? ["Knife", "AWP", "Glock-18"] : ["Knife", "AK-47"],
        team_clan_name: team === "A" ? "Vitality" : "FaZe",
      });
    }
  }
  // Timeout för B (T) före runda 5.
  const r4 = rounds[3];
  const r5 = rounds[4];
  const timeoutSamples: RawRow[] = [
    { tick: r4.endTick + 64, steamid: "b1", is_terrorist_timeout: false, is_ct_timeout: false },
    { tick: r5.startTick + 64, steamid: "b1", is_terrorist_timeout: true, is_ct_timeout: false },
  ];
  // Granat: b2 kastar en smoke i runda 1 som landar vid (100,100,0).
  const g1 = roundTicks(1).freezeEnd + 3 * TR;
  const grenades: RawRow[] = [
    { grenade_type: "SmokeGrenade", grenade_entity_id: 77, x: 0, y: 0, z: 0, tick: g1, steamid: "b2", name: "B2" },
    { grenade_type: "SmokeGrenade", grenade_entity_id: 77, x: 100, y: 100, z: 0, tick: g1 + 2 * TR, steamid: "b2", name: "B2" },
  ];
  const gridSamples: RawRow[] = [
    { tick: 5000, X: 100, Y: 100, Z: 0, last_place_name: "Window", is_alive: true },
    { tick: 5001, X: 110, Y: 120, Z: 0, last_place_name: "Window", is_alive: true },
  ];
  return { header: { map_name: "de_mirage" }, events, grenades, samples, timeoutSamples, gridSamples, sampleTicks };
}

