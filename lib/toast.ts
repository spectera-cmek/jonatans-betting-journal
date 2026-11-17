// A tiny toast bus: any component can call toast(...) and the one <Toaster>
// in the app layout shows it. No context provider needed.

export type ToastTone = "pos" | "neg" | "info";

export type ToastInput = {
  title: string;
  detail?: string;
  tone?: ToastTone;
  /** One optional action button, e.g. "Ångra". */
  action?: { label: string; run: () => void | Promise<void> };
  /** ms before it leaves on its own. Default 4 s, 6 s when it has an action. */
  duration?: number;
};

export type Toast = ToastInput & { id: number };

type Listener = (t: Toast) => void;
const listeners = new Set<Listener>();
let nextId = 1;

export function toast(input: ToastInput) {
  const t: Toast = { ...input, id: nextId++ };
  listeners.forEach((fn) => fn(t));
  return t.id;
}

export function onToast(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const OUTCOME_LABEL: Record<string, string> = {
  win: "Vunnen",
  loss: "Förlorad",
  push: "Push",
  void: "Void",
  half_win: "½ vunnen",
  half_loss: "½ förlorad",
};

export function outcomeLabel(outcome: string) {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

export function outcomeTone(outcome: string): ToastTone {
  if (outcome === "win" || outcome === "half_win") return "pos";
  if (outcome === "loss" || outcome === "half_loss") return "neg";
  return "info";
}
