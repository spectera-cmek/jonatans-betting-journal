"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

interface Point {
  date: string;
  bankrollUnits: number;
  profitUnits: number;
}

export function BankrollChart({
  data,
  startingBankroll,
}: {
  data: Point[];
  startingBankroll: number;
}) {
  const chartData = data.map((p, i) => ({
    idx: i,
    date: new Date(p.date).toLocaleDateString("sv-SE", {
      month: "short",
      day: "numeric",
    }),
    bankroll: p.bankrollUnits,
  }));

  const last = data[data.length - 1]?.bankrollUnits ?? startingBankroll;
  const up = last >= startingBankroll;
  const stroke = up ? "#00D97E" : "#FF3D5A";

  if (data.length <= 1) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-text-lo">
        Inga avgjorda bets än — lägg in resultat för att se bankrullen växa.
      </div>
    );
  }

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="bankrollFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#172033" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#64748B", fontSize: 11 }}
            axisLine={{ stroke: "#1F2A44" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "#64748B", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={48}
            tickFormatter={(v) => `${v}U`}
          />
          <Tooltip
            contentStyle={{
              background: "#111927",
              border: "1px solid #1F2A44",
              borderRadius: 8,
              color: "#F8FAFC",
              fontSize: 12,
            }}
            labelStyle={{ color: "#94A3B8" }}
            formatter={(v: number) => [`${v.toFixed(2)}U`, "Bankroll"]}
          />
          <ReferenceLine y={startingBankroll} stroke="#1F2A44" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="bankroll"
            stroke={stroke}
            strokeWidth={2}
            fill="url(#bankrollFill)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
