import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type ThemePref = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (pref: ThemePref) => void;
}

const STORAGE_KEY = "merchantid-console-theme";

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Applies the stored theme before first paint to avoid a flash. Injected into
 * <head> as a blocking script - it mirrors the resolution logic below.
 */
export const themeBootScript = `(function(){try{var p=localStorage.getItem("${STORAGE_KEY}")||"system";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){}})();`;

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  // Hydrate from storage after mount; the boot script has already painted the
  // correct theme, so this only syncs React state.
  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as ThemePref) ?? "system";
    setPrefState(stored);
    setResolved(resolve(stored));
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    setResolved(resolve(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode storage failures are non-fatal; the theme still applies
      // for the session.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ pref, resolved, setPref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
