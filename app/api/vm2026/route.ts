import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { fetchWorldCupData } from "@/lib/worldCup";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const data = await fetchWorldCupData();
  return NextResponse.json(data, {
    status: data.matches.length > 0 ? 200 : 503,
    headers: {
      "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
    },
  });
}
