import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThemeProvider, type Appearance } from "@parrot-co/parrot-ui";

/** Mirrors web/src/lib/theme.tsx: the same storage key, the same body stamp, the same ThemeProvider props. */
export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "patchwork-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeModeContext = createContext<{ mode: ThemeMode; colorScheme: Appearance; setMode: (m: ThemeMode) => void }>({
  mode: "system",
  colorScheme: "light",
  setMode: () => undefined,
});

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

function subscribeSystem(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSystemScheme(): Appearance {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const systemScheme = useSyncExternalStore(subscribeSystem, getSystemScheme);
  const colorScheme = mode === "system" ? systemScheme : mode;

  useEffect(() => {
    document.body.setAttribute("data-theme", colorScheme);
  }, [colorScheme]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode */
    }
  }

  return (
    <ThemeModeContext.Provider value={{ mode, colorScheme, setMode }}>
      <ThemeProvider radius="md" color="neutral" colorScheme={colorScheme}>
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode() {
  return useContext(ThemeModeContext);
}
