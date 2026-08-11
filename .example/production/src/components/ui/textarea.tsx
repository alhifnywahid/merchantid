import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-16 w-full min-w-0 resize-y rounded-md border border-input bg-foreground/[0.04] px-2 py-1.5 text-xs outline-none transition-[border-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]",
        "placeholder:text-muted-foreground/75 focus:border-primary",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
