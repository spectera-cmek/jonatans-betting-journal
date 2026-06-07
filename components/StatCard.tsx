import { signClass } from "@/lib/format";

type Accent = "green" | "blue" | "purple" | "amber";

const accentBar: Record<Accent, string> = {
  green: "bg-pos",
  blue: "bg-accent-blue",
  purple: "bg-accent-purple",
  amber: "bg-accent-amber",
};

export function StatCard({
  label,
  value,
  sub,
  accent = "blue",
  signed,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: Accent;
  signed?: number | null;
}) {
  const colorClass =
    signed === undefined ? "text-text-hi" : signClass(signed ?? 0);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card shadow-card">
      <div className={`h-1 w-full ${accentBar[accent]}`} />
      <div className="px-5 pb-5 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-mid">
          {label}
        </div>
        <div className={`tnum mt-2 text-3xl font-bold ${colorClass}`}>
          {value}
        </div>
        {sub && <div className="mt-1 text-[11px] text-text-lo">{sub}</div>}
      </div>
    </div>
  );
}
