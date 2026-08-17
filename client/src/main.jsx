import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { StatusBar } from "@capacitor/status-bar";
// Self-hosted so the font survives with no internet: both the packaged desktop
// app and the phone run on a LAN with no reason to reach Google. Only the four
// weights the design system defines are imported.
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "./index.css";

StatusBar.setOverlaysWebView({ overlay: true });
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
