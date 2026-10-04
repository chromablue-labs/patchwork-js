import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { App } from "./app";
import { EngineProvider } from "./lib/engine";
import { SourceProvider } from "./lib/source-context";
import { ThemeModeProvider } from "./lib/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeModeProvider>
      <EngineProvider>
        <SourceProvider>
          <App />
        </SourceProvider>
      </EngineProvider>
    </ThemeModeProvider>
  </StrictMode>,
);
