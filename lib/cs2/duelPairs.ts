// Förval av par för killduell i snabbläget: roll mot roll (AWP mot AWP, entry
// mot entry …), som böckerna brukar para ihop dem. Spelare utan roll — eller
// utan motsvarighet i andra laget — paras efter förväntade kills, bäst mot bäst.
// Rent och utan beroenden, så att klienten kan använda det.

export interface DuelCandidate {
  playerId: number;
  side: 1 | 2;
  role: string | null;
  /** Förväntade kills på kartan (modellens linje) — ordning inom laget. */
  kills: number;
}

export function rolePairs(players: DuelCandidate[]): Array<{ a: number; b: number }> {
  const byKills = (x: DuelCandidate, y: DuelCandidate) => y.kills - x.kills;
  const t1 = players.filter((p) => p.side === 1).sort(byKills);
  const t2 = players.filter((p) => p.side === 2).sort(byKills);
  const used = new Set<number>();
  const pairs: Array<{ a: number; b: number }> = [];
  const role = (p: DuelCandidate) => p.role?.trim().toLowerCase() || null;

  // Samma roll först; vid flera med samma roll (två riflers) bäst mot bäst.
  const left: DuelCandidate[] = [];
  for (const a of t1) {
    const b = role(a) ? t2.find((x) => !used.has(x.playerId) && role(x) === role(a)) : undefined;
    if (b) {
      used.add(b.playerId);
      pairs.push({ a: a.playerId, b: b.playerId });
    } else left.push(a);
  }
  const rest = t2.filter((x) => !used.has(x.playerId));
  left.forEach((a, i) => {
    if (rest[i]) pairs.push({ a: a.playerId, b: rest[i].playerId });
  });
  // I lag 1:s ordning efter kills, så att listan ser likadan ut varje gång.
  const order = new Map(t1.map((p, i) => [p.playerId, i]));
  return pairs.sort((x, y) => order.get(x.a)! - order.get(y.a)!);
}
