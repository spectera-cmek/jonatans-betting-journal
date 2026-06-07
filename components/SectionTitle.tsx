type Accent = "green" | "blue" | "purple" | "amber";

const borderColor: Record<Accent, string> = {
  green: "border-pos",
  blue: "border-accent-blue",
  purple: "border-accent-purple",
  amber: "border-accent-amber",
};

export function SectionTitle({
  children,
  accent = "green",
  right,
}: {
  children: React.ReactNode;
  accent?: Accent;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2
        className={`border-l-4 pl-3 text-[13px] font-bold uppercase tracking-wide text-text-hi ${borderColor[accent]}`}
      >
        {children}
      </h2>
      {right}
    </div>
  );
}
