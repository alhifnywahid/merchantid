import * as React from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// A native <select> kept in the Tokokino idiom rather than a Radix listbox:
// the console is dense and the option sets are short, so the platform control
// is the honest choice. Focus signals by border colour, matching Input.
function Select({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        data-slot="select"
        className={cn(
          "h-7 w-full min-w-0 appearance-none rounded-md border border-input bg-foreground/[0.04] pr-7 pl-2 text-xs outline-none transition-[border-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]",
          "focus:border-primary disabled:cursor-not-allowed disabled:opacity-45",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <CaretDown
        aria-hidden="true"
        weight="bold"
        className="pointer-events-none absolute right-2 size-3 text-muted-foreground"
      />
    </span>
  );
}

export { Select };
