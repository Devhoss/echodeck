import { useState } from "react";
import {
  BarcodeScanner,
  BarcodeFormat,
} from "@capacitor-mlkit/barcode-scanning";

export default function PairingScreen({ onPaired }) {
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("9001");
  const [error, setError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [scanning, setScanning] = useState(false);

  async function startScan() {
    setError(null);

    try {
      // Check/request permission
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== "granted" && camera !== "limited") {
        setError(
          "Camera permission required. Enable it in Settings → Apps → EchoDeck → Permissions.",
        );
        return;
      }

      // Check if ML Kit is available (may need to download on first run)
      const { available } =
        await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!available) {
        await BarcodeScanner.installGoogleBarcodeScannerModule();
        setError("Scanner module is installing, please try again in a moment.");
        return;
      }

      setScanning(true);

      const { barcodes } = await BarcodeScanner.scan({
        formats: [BarcodeFormat.QrCode],
      });

      setScanning(false);

      if (barcodes.length === 0) {
        setError("No QR code detected. Please try again.");
        return;
      }

      parsePairUrl(barcodes[0].rawValue);
    } catch (err) {
      setScanning(false);
      console.error("SCAN ERROR:", err);
      if (err?.message?.includes("cancel")) {
        // user dismissed — no error shown
      } else {
        setError("Scan failed: " + (err?.message ?? "unknown error"));
      }
    }
  }

  function parsePairUrl(raw) {
    const cleaned = raw.trim();
    console.log("RAW QR:", cleaned);

    try {
      const queryString = cleaned.includes("?")
        ? cleaned.split("?")[1]
        : cleaned;
      const params = new URLSearchParams(queryString);
      const host = params.get("host");
      const port = parseInt(params.get("port") || "9001", 10);
      const token = params.get("token");

      console.log("PAIR PARAMS:", { host, port, token });
      if (!host) throw new Error("No host param in QR");
      connectAndPair(host, port, token);
    } catch (err) {
      console.error("PARSE ERROR:", err, cleaned);
      setError(
        "Invalid QR code. Make sure you scan the EchoDeck pairing code.",
      );
    }
  }

  async function connectAndPair(host, port, token) {
    setTesting(true);
    setError(null);
    try {
      const res = await fetch(`http://${host}:${port}/api/pair-info`, {
        signal: AbortSignal.timeout(4000),
      });
      const data = await res.json();
      if (token && data.token !== token) {
        setError("Token mismatch — make sure you scan the current QR code.");
        setTesting(false);
        return;
      }
      onPaired(host, port, data.token);
    } catch {
      setError(
        `Could not reach EchoDeck at ${host}:${port}. Make sure your PC is on the same network.`,
      );
    }
    setTesting(false);
  }

  async function connectManual() {
    if (!manualHost.trim()) return;
    connectAndPair(manualHost.trim(), parseInt(manualPort, 10) || 9001, null);
  }

  return (
    <div style={styles.root}>
      <div style={styles.logo}>
        <div style={styles.logoMark}>🎛</div>
        <h1 style={styles.title}>EchoDeck</h1>
        <p style={styles.subtitle}>Connect to your PC</p>
      </div>

      <div style={styles.card}>
        <p style={styles.step}>Step 1 — Open EchoDeck on your PC</p>
        <p style={styles.step}>
          Step 2 — Click{" "}
          <strong style={{ color: "#a5b4fc" }}>Connect Phone</strong> in the top
          bar
        </p>
        <p style={styles.step}>Step 3 — Scan the QR code below</p>

        <button
          style={{
            ...styles.primaryBtn,
            opacity: testing || scanning ? 0.7 : 1,
          }}
          onClick={startScan}
          disabled={testing || scanning}
        >
          {scanning
            ? "📷  Point at QR code…"
            : testing
              ? "Connecting…"
              : "📷  Scan QR Code"}
        </button>
      </div>

      <div style={styles.divider}>
        <span style={styles.dividerText}>or enter manually</span>
      </div>

      <div style={styles.card}>
        <label style={styles.label}>PC IP Address</label>
        <input
          style={styles.input}
          value={manualHost}
          onChange={(e) => setManualHost(e.target.value)}
          placeholder="192.168.x.x"
          autoComplete="off"
          autoCapitalize="none"
        />
        <label style={styles.label}>Port</label>
        <input
          style={styles.input}
          value={manualPort}
          onChange={(e) => setManualPort(e.target.value)}
          placeholder="9001"
          inputMode="numeric"
        />
        <button
          style={{
            ...styles.secondaryBtn,
            opacity: testing || !manualHost.trim() ? 0.5 : 1,
          }}
          onClick={connectManual}
          disabled={testing || !manualHost.trim()}
        >
          {testing ? "Connecting…" : "Connect"}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    minHeight: "100dvh",
    overflowY: "auto",
    overflowX: "hidden",
    padding: "40px 24px 80px",
    background: "radial-gradient(circle at top, #1f2230, #090909 70%)",
    fontFamily: "'SF Pro Display', 'Segoe UI', sans-serif",
    color: "#ccc",
    paddingTop: "env(safe-area-inset-top)",
    WebkitOverflowScrolling: "touch",
  },
  logo: { textAlign: "center", marginBottom: 32 },
  logoMark: { fontSize: 48, marginBottom: 8 },
  title: { fontSize: 28, fontWeight: 800, color: "#e0e0e0", margin: 0 },
  subtitle: { fontSize: 14, color: "#555", margin: "6px 0 0" },
  card: {
    width: "100%",
    maxWidth: 360,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  step: { fontSize: 13, color: "#888", marginBottom: 8, lineHeight: 1.6 },
  primaryBtn: {
    width: "100%",
    padding: "14px 0",
    marginTop: 8,
    background: "linear-gradient(135deg, #6c63ff, #3b82f6)",
    border: "none",
    borderRadius: 12,
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryBtn: {
    width: "100%",
    padding: "12px 0",
    marginTop: 8,
    background: "rgba(108,99,255,0.15)",
    border: "1px solid rgba(108,99,255,0.4)",
    borderRadius: 12,
    color: "#a5b4fc",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  label: {
    display: "block",
    fontSize: 11,
    fontWeight: 700,
    color: "#555",
    letterSpacing: 0.8,
    marginBottom: 5,
    textTransform: "uppercase",
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    marginBottom: 12,
    background: "#1a1a22",
    border: "1px solid #2a2a35",
    borderRadius: 8,
    color: "#ccc",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  divider: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    maxWidth: 360,
    margin: "4px 0 16px",
  },
  dividerText: {
    fontSize: 11,
    color: "#444",
    padding: "0 12px",
    whiteSpace: "nowrap",
  },
  error: {
    maxWidth: 360,
    width: "100%",
    padding: "12px 16px",
    marginTop: 8,
    background: "#2e0d0d",
    border: "1px solid #5c1a1a",
    borderRadius: 10,
    color: "#f87171",
    fontSize: 12,
    lineHeight: 1.6,
  },
};
