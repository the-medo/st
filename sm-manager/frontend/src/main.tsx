import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app/App";
import "../../sm_manager/static/style.css";
import "../../sm_manager/static/home.css";
import "./styles.css";
import { MonitorProvider } from "./features/MonitorContext";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <MonitorProvider>
        <App />
      </MonitorProvider>
    </BrowserRouter>
  </StrictMode>,
);
