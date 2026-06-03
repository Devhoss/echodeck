import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { StatusBar } from "@capacitor/status-bar";
import "./index.css";

StatusBar.setOverlaysWebView({ overlay: true });
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
