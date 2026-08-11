import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Mono uppercase pill with a leading status dot. The dot is semantic here -
// it marks provider/payment state - which is the one case the design system
// permits a coloured status dot.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase leading-tight tracking-[0.06em] whitespace-nowrap before:size-[0.3125rem] before:rounded-full before:bg-current before:content-['']",
  {
    variants: {
      variant: {
        neutral: "border-border text-muted-foreground",
        info: "border-border text-foreground/60",
        success: "border-accent-foreground/25 bg-accent text-accent-foreground",
        // "Not settled yet" borrows weight from the foreground rather than a
        // second hue; --primary stays action-only.
        warning: "border-foreground/40 text-foreground",
        danger: "border-destructive/30 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
