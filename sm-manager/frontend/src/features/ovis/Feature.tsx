import { agentsShortcuts } from "./shortcuts";
import { ovisTheme } from "@st/theme/ovis";
import { themeName } from "@st/theme";
import "@st/theme/ovis.css";
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
const hostThemes = {
  console: ovisTheme("console"),
  workmode: ovisTheme("workmode"),
};
export default function Feature({ workmode }: { workmode: boolean }) {
  useEffect(() => watchSheetExits(), []);
  return (
    <RenderBoundary
      resetKey={null}
      fallback={(_retry, error) => <AppCrash error={error} />}
    >
      <SettingsProvider
        hostAppearance={{
          entry: hostThemes[themeName(workmode)],
          description: (
            <p>
              S.T. {workmode ? "Workmode" : "console"} theme · Colors follow the
              S.T. sidebar.
            </p>
          ),
        }}
      >
        {reader ? (
          <FileReader target={reader} />
        ) : (
          <App hostShortcuts={agentsShortcuts} />
        )}
      </SettingsProvider>
    </RenderBoundary>
  );
}
