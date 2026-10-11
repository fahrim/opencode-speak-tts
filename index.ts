/**
 * Server-side entry point.
 *
 * All the real work happens in the terminal, but discovery runs through the
 * server: the CLI asks which plugins are active and loads the `./tui` export of
 * the ones flagged `tui: true`. Without this file and that flag the TUI half of
 * the plugin is never loaded.
 *
 * This file deliberately has no imports — a local plugin can fail to load if it
 * tries to resolve packages while the server is booting.
 */
export default {
  id: "opencode-tts",
  tui: true,
  async setup() {},
};