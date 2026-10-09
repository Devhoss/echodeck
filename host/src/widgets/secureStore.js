/**
 * secureStore.js  —  host/src/secureStore.js
 *
 * The only place an SSH key passphrase may touch disk, and it is never stored
 * in plain text. Electron's safeStorage encrypts with the OS credential store
 * (DPAPI on Windows), which means the blob is only decryptable on the machine
 * and the Windows user that produced it.
 *
 * The server also runs under plain node (`npm run dev`), where Electron is not
 * available at all. That is not an error: a passphrase simply cannot be stored
 * in that mode, and the editor says so rather than pretending.
 *
 * Note on detection: `require("electron")` from plain node resolves to the npm
 * shim, which exports a string path and does not throw. So the check is for a
 * usable safeStorage, not for a successful require.
 */

let cached = null;

function backend() {
  if (cached !== null) return cached;
  try {
    const electron = require("electron");
    const safe = electron && electron.safeStorage;
    if (safe && typeof safe.encryptString === "function") cached = safe;
    else cached = null;
  } catch {
    cached = null;
  }
  return cached;
}

/** True when a passphrase can be stored and read back on this machine. */
function isEncryptionAvailable() {
  const safe = backend();
  if (!safe) return false;
  try {
    return safe.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** @returns {string|null} base64 ciphertext, or null when unavailable */
function encrypt(plaintext) {
  const safe = backend();
  if (!safe || !plaintext) return null;
  try {
    if (safe.isEncryptionAvailable && !safe.isEncryptionAvailable()) return null;
    return Buffer.from(safe.encryptString(plaintext)).toString("base64");
  } catch (e) {
    console.warn("⚠️  Could not encrypt a passphrase:", e.message);
    return null;
  }
}

/** @returns {string|null} the plaintext, or null when it cannot be recovered */
function decrypt(base64) {
  const safe = backend();
  if (!safe || !base64) return null;
  try {
    const buf = Buffer.from(base64, "base64");
    if (!buf.length) return null;
    return safe.decryptString(buf);
  } catch (e) {
    // Expected when the DB was copied to another machine or user.
    console.warn("⚠️  Could not decrypt the stored passphrase:", e.message);
    return null;
  }
}

module.exports = { isEncryptionAvailable, encrypt, decrypt };
