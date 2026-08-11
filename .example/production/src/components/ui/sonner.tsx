import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/components/theme";

// Sonner styled to the Tokokino surface: card background, hairline border, no
// shadow, one coral action colour. Reads the app's own theme store rather than
// next-themes.
function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-md !border !border-border !bg-popover/95 !text-popover-foreground !text-xs !shadow-none backdrop-blur-md",
          description: "!text-muted-foreground",
          actionButton:
            "!bg-primary !text-primary-foreground !rounded-sm !text-xs",
          cancelButton:
            "!bg-secondary !text-secondary-foreground !rounded-sm !text-xs",
          error: "!text-destructive !border-destructive/30",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
