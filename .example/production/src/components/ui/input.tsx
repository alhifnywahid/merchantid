import * as React from "react";
import { cn } from "@/lib/utils";

// Inputs signal focus by border colour alone; buttons by ring. That split is
// deliberate in the Tokokino system — do not add a ring here.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-md border border-input bg-foreground/[0.04] px-2 text-xs outline-none transition-[border-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]",
        "placeholder:text-muted-foreground/75 focus:border-primary",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
