import * as React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Label + control + optional hint, stacked. The console's single form idiom.
function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? (
        <span className="text-[0.6875rem] leading-snug text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export { Field };
