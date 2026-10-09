// Tests for SSH key path resolution. The whole point of this module is that a
// `~` or `%USERPROFILE%` path never reaches ssh2 unexpanded.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const {
  DEFAULT_KEY_NAMES,
  expandHome,
  findDefaultKey,
  resolveKeyPath,
} = require("../src/widgets/keyPath.js");

test("~ expands to the real home directory", () => {
  const home = os.homedir();
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("~/.ssh/id_ed25519"), path.join(home, ".ssh", "id_ed25519"));
  assert.equal(expandHome("~\\.ssh\\id_ed25519"), path.join(home, ".ssh", "id_ed25519"));
});

test("Windows environment variables expand", () => {
  process.env.ECHODECK_TEST_HOME = "C:\\Users\\hossa";
  assert.equal(
    expandHome("%ECHODECK_TEST_HOME%\\.ssh\\id_ed25519"),
    path.normalize("C:\\Users\\hossa\\.ssh\\id_ed25519"),
  );
  delete process.env.ECHODECK_TEST_HOME;
});

test("an unknown variable is left alone rather than blanked", () => {
  // Blanking it would silently turn a typo into "no key configured".
  assert.equal(expandHome("%NOT_A_REAL_VAR_X%\\.ssh\\id_ed25519"), "%NOT_A_REAL_VAR_X%\\.ssh\\id_ed25519");
});

test("an absolute path passes through untouched", () => {
  const abs = "C:\\Users\\hossa\\.ssh\\id_ed25519";
  assert.equal(expandHome(abs), path.normalize(abs));
});

test("empty input is rejected before it reaches the filesystem", () => {
  assert.equal(expandHome(""), null);
  assert.equal(expandHome("   "), null);
  assert.equal(expandHome(null), null);
  const bad = resolveKeyPath("");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /no key path configured/);
});

test("the default key candidates are the OpenSSH names, in order", () => {
  assert.deepEqual(DEFAULT_KEY_NAMES, ["id_ed25519", "id_rsa", "id_ecdsa"]);
});

test("findDefaultKey returns the first key that exists", () => {
  // Nothing exists
  assert.equal(findDefaultKey(() => false), null);

  const home = os.homedir();
  const ed25519 = path.join(home, ".ssh", "id_ed25519");
  // Only the second candidate exists
  const onlyRsa = (p) => p === path.join(home, ".ssh", "id_rsa");
  assert.equal(findDefaultKey(onlyRsa), path.join(home, ".ssh", "id_rsa"));

  // ed25519 wins when both exist
  const both = (p) => p === ed25519 || p === path.join(home, ".ssh", "id_rsa");
  assert.equal(findDefaultKey(both), ed25519);
});

test("findDefaultKey survives an unreadable home directory", () => {
  const thrower = () => {
    throw new Error("EACCES");
  };
  assert.doesNotThrow(() => findDefaultKey(thrower));
  assert.equal(findDefaultKey(thrower), null);
});

test("resolveKeyPath reports a missing file with the path it tried", () => {
  const missing = path.join(os.tmpdir(), "echodeck-no-such-key-xyz");
  const result = resolveKeyPath(missing, () => false);
  assert.equal(result.ok, false);
  assert.match(result.reason, /key file not found/);
  assert.match(result.reason, /echodeck-no-such-key-xyz/i);
});

test("resolveKeyPath resolves a real file to an absolute path", () => {
  const fs = require("fs");
  const real = path.join(os.tmpdir(), "echodeck-key-probe");
  fs.writeFileSync(real, "not a key\n");
  try {
    const result = resolveKeyPath(real);
    assert.equal(result.ok, true);
    assert.equal(path.isAbsolute(result.path), true);
    assert.equal(result.path, path.normalize(real));
  } finally {
    fs.rmSync(real, { force: true });
  }
});
