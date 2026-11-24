import "../../../../integrations/ovis/app/src/lib/builtins.ts";
import "../../../../integrations/ovis/app/src/lib/legacyStorage.ts";
import "../../../../integrations/ovis/app/src/fonts/fonts.css";
import "../../../../integrations/ovis/app/src/styles.css";
import { App } from "../../../../integrations/ovis/app/src/App.tsx";
import { SettingsProvider } from "../../../../integrations/ovis/app/src/lib/settings.ts";
import { RenderBoundary } from "../../../../integrations/ovis/app/src/components/RenderBoundary.tsx";
import { AppCrash } from "../../../../integrations/ovis/app/src/components/AppCrash.tsx";
import {
  nativeTransport,
  setTransport,
} from "../../../../integrations/ovis/app/src/lib/transport.ts";
import { useEffect } from "react";
import { watchSheetExits } from "../../../../integrations/ovis/app/src/lib/sheets.ts";
import { FileReader } from "../../../../integrations/ovis/app/src/components/FileReader.tsx";
import { readerFromSearch } from "../../../../integrations/ovis/app/src/lib/fileReader.ts";
import { ovisUrl } from "./host";
setTransport({ ...nativeTransport, resourceUrl: ovisUrl });
const reader = readerFromSearch(window.location.search);
export default function Feature() {
  useEffect(() => watchSheetExits(), []);
  return (
    <RenderBoundary
      resetKey={null}
      fallback={(_retry, error) => <AppCrash error={error} />}
    >
      <SettingsProvider>
        {reader ? <FileReader target={reader} /> : <App />}
      </SettingsProvider>
    </RenderBoundary>
  );
}
