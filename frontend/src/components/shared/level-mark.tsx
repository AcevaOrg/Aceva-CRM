import { cn } from "@/lib/utils";
import type { Level } from "@/types";
import { LEVEL_LABEL } from "@/lib/auth/permissions";

const LEVEL_BG: Record<Level, string> = {
  1: "bg-level-1",
  2: "bg-level-2",
  3: "bg-level-3",
  4: "bg-level-4",
  5: "bg-level-5",
};

/**
 * Five stacked strata bars; the bar for the person's level is filled (spec §3.5.4).
 * Level 1 is the top bar.
 */
export function LevelMark({
  level,
  label,
  showLabel = false,
  className,
}: {
  level: Level;
  label?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const text = label ?? LEVEL_LABEL[level];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={`Level ${level} · ${text}`}>
      <span className="inline-flex flex-col gap-[2px]" aria-hidden>
        {([1, 2, 3, 4, 5] as Level[]).map((l) => (
          <span
            key={l}
            className={cn("block h-[2.5px] rounded-full", l === level ? LEVEL_BG[level] : "bg-current opacity-15")}
            style={{ width: 8 + l * 1.6 }}
          />
        ))}
      </span>
      {showLabel && (
        <span className="text-[11.5px] font-medium text-muted-foreground">
          L{level} · {text}
        </span>
      )}
      <span className="sr-only">
        Level {level}, {text}
      </span>
    </span>
  );
}
