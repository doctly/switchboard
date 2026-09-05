// Pure launch-state helpers shared by main and unit tests.

/**
 * Decide whether an open-terminal request should create a new CLI session.
 *
 * A caller may deliberately seed a transcript before the cache indexer has
 * seen it (the schedule creator does this to provide its welcome message).
 * Such a session must be resumed even when there is no cached row yet.
 */
function shouldStartFresh({ isNew, isPlainTerminal, hasCachedSession, resumeExisting }) {
  if (isNew) return true;
  if (isPlainTerminal) return false;
  if (resumeExisting) return false;
  return !hasCachedSession;
}

module.exports = { shouldStartFresh };
