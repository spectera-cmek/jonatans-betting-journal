import { NextResponse } from "next/server";
import { prisma, getSettings } from "@/lib/db";
import { hasOddsApiKey } from "@/lib/oddsApi";
import { getSessionUser, getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return apiUnauthorized();
  const s = await getSettings(user.id);
  return NextResponse.json({
    username: user.username,
    unitValue: s.unitValue,
    currency: s.currency,
    startingBankrollUnits: s.startingBankrollUnits,
    dailyStakeBudgetUnits: s.dailyStakeBudgetUnits,
    weeklyStakeBudgetUnits: s.weeklyStakeBudgetUnits,
    hasOddsApiKey: hasOddsApiKey(),
  });
}

export async function PUT(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    const body = await req.json();
    const data: Record<string, unknown> = {};

    if (body.unitValue !== undefined) {
      const v = Number(body.unitValue);
      if (Number.isNaN(v) || v <= 0)
        return NextResponse.json({ error: "unitValue must be > 0" }, { status: 400 });
      data.unitValue = v;
    }
    if (body.currency !== undefined) {
      const c = String(body.currency).trim();
      if (!c) return NextResponse.json({ error: "currency required" }, { status: 400 });
      data.currency = c;
    }
    if (body.startingBankrollUnits !== undefined) {
      const v = Number(body.startingBankrollUnits);
      if (Number.isNaN(v))
        return NextResponse.json({ error: "invalid bankroll" }, { status: 400 });
      data.startingBankrollUnits = v;
    }
    // Tilt budgets: null/0/"" clears, otherwise a positive number of units.
    for (const key of ["dailyStakeBudgetUnits", "weeklyStakeBudgetUnits"] as const) {
      if (body[key] === undefined) continue;
      if (body[key] === null || body[key] === "" || Number(body[key]) === 0) {
        data[key] = null;
        continue;
      }
      const v = Number(body[key]);
      if (Number.isNaN(v) || v < 0)
        return NextResponse.json({ error: `${key} must be >= 0` }, { status: 400 });
      data[key] = v;
    }

    const s = await prisma.setting.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    return NextResponse.json({
      unitValue: s.unitValue,
      currency: s.currency,
      startingBankrollUnits: s.startingBankrollUnits,
      dailyStakeBudgetUnits: s.dailyStakeBudgetUnits,
      weeklyStakeBudgetUnits: s.weeklyStakeBudgetUnits,
      hasOddsApiKey: hasOddsApiKey(),
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
