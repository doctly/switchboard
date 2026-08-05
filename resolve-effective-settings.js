/**
 * Merge saved settings over defaults for a project.
 *
 * Scopes apply narrowest-last: defaults, then global, then project.
 *
 * Only `undefined` — the key was never saved at that scope — falls through to
 * the next-broader value. An explicit `null` is a real, deliberate choice and
 * wins like any other value. The settings panel relies on this: it persists
 * permissionMode's "Default (none)" option as `value || null`, so `null` there
 * means "pass no --permission-mode flag", not "unset".
 *
 * Extracted from main.js's get-effective-settings handler so this rule can be
 * unit-tested without booting Electron.
 */
function resolveEffectiveSettings(defaults, global = {}, project = {}) {
  const effective = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (global[key] !== undefined) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined) {
      effective[key] = project[key];
    }
  }
  return effective;
}

module.exports = { resolveEffectiveSettings };
