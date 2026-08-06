// Deciding what a restarted Firefox should restore. Pure functions on session state
// (see scripts/lib/mozlz4.js for the container) so scripts/test-session-repair.js can
// exercise every branch without driving a browser.

// A window Firefox filed under "recently closed" is shaped like an open one plus two
// bookkeeping fields; drop them and it can go straight back into state.windows.
function reopen(win) {
	const open = { ...win };
	delete open.closedAt;
	delete open.closedId;
	return open;
}

/**
 * Work out the session to restore after a shutdown that closed every window.
 *
 * @param final    the state Firefox wrote at quit (authoritative, freshest)
 * @param snapshot the state captured while it was still running (complete, but up to
 *                 one save-interval old); null if we could not capture one
 * @param sinceMs  when we started closing windows -- anything closed at/after this is ours
 * @returns {{state, note, changed}}
 */
function repairSession(final, snapshot, sinceMs) {
	const want = ((snapshot && snapshot.windows) || []).length;
	const have = (s) => (s.windows || []).length;
	if (!final) {
		if (!snapshot) return { state: null, note: "no session to work with", changed: false };
		return { state: stopped(snapshot), note: `rebuilt from the pre-close snapshot (${want} windows)`, changed: true };
	}
	if (want && have(final) >= want) {
		return { state: final, note: `all ${have(final)} window(s) survived the shutdown`, changed: false };
	}

	const notes = [];
	let state = { ...final };
	// Prefer what Firefox saved at quit -- it is fresher than the snapshot.
	const closed = state._closedWindows || [];
	const ours = closed.filter((w) => (w.closedAt || 0) >= sinceMs - 5000);
	if (ours.length) {
		state.windows = (state.windows || []).concat(ours.map(reopen));
		state._closedWindows = closed.filter((w) => !ours.includes(w));
		notes.push(`recovered ${ours.length} from "recently closed"`);
	}
	if (want && have(state) < want) {
		state = stopped(snapshot);
		notes.push(`rebuilt from the pre-close snapshot (${want} windows)`);
	}
	if (!notes.length) {
		return { state: final, note: `${have(final)} window(s) in the session; nothing better available`, changed: false };
	}
	return { state, note: `${have(state)} window(s) restored -- ${notes.join("; ")}`, changed: true };
}

// Firefox reads a session still marked "running" as a crash and asks before restoring.
function stopped(state) {
	return { ...state, session: { ...(state.session || {}), state: "stopped" } };
}

module.exports = { repairSession };
