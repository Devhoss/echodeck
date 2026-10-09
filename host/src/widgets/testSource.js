/**
 * testSource.js  —  host/src/widgets/testSource.js
 *
 * "Try this host now" for a data source, used by both REST shapes: the editor
 * can test a host that is already saved, or one the user is still typing. It
 * builds a throwaway collector, runs the same probe the poller runs, and tears
 * it down — never touching the live poller or the stored row.
 */

const { createSshSource, classifyError } = require("./sources/sshSource.js");

/**
 * @param {object} config a widget_sources-shaped object (needs host, port,
 *   username, key_path, auth, use_agent). `id` is only used for logging.
 * @returns {Promise<{ok: boolean, detail?: string, reason?: string, status?: string}>}
 */
async function testSourceConfig(config) {
  if (!config || !config.host) {
    return { ok: false, reason: "no host configured", status: "auth_error" };
  }
  const source = createSshSource({
    id: config.id || null,
    host: config.host,
    port: Number(config.port) || 22,
    username: config.username || "",
    key_path: config.key_path,
    auth: config.auth,
    use_agent: Number(config.use_agent) === 1,
  });

  try {
    const result = await source.test();
    return result;
  } catch (e) {
    // The reason is what the editor shows, and it has to distinguish "wrong key"
    // from "host asleep" — the user's next action is different for each.
    const info = classifyError(e);
    return { ok: false, reason: info.message, status: info.status };
  } finally {
    try {
      source.close();
    } catch {
      /* closing a source that never opened is not an error */
    }
  }
}

module.exports = { testSourceConfig };
