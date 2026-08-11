import { useTheme } from "@/components/theme";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "LT" },
  { value: "system", label: "SYS" },
  { value: "dark", label: "DK" },
] as const;

// A segmented mono switch, not a sun/moon toggle — the drafting-instrument
// idiom of the system.
export function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-px overflow-hidden rounded-sm border border-border bg-border"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={pref === option.value}
          onClick={() => setPref(option.value)}
          className={cn(
            "min-h-[1.375rem] bg-background px-[0.4375rem] font-mono text-[0.5625rem] uppercase tracking-[0.12em] transition-[background-color,color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]",
            pref === option.value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
