// Fast, browser-free tests for the session repair that keeps every Firefox window
// across `install_local.js --restart`, plus a round-trip of the mozLz4 container.
//
//   node scripts/test-session-repair.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { repairSession } = require("./lib/session.js");
const mozlz4 = require("./lib/mozlz4.js");

let failed = 0;
const check = (label, cond, extra = "") => {
	if (!cond) failed++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const NOW = 1_700_000_000_000;
const win = (name, tabs = 1) => ({
	tabs: Array.from({ length: tabs }, (_, i) => ({
		entries: [{ url: `https://example.com/${name}/${i}` }],
		index: 1,
	})),
});
const closedWin = (name, tabs, closedAt) => ({ ...win(name, tabs), closedAt, closedId: 7 });
const names = (state) =>
	(state.windows || []).map((w) => w.tabs[0].entries[0].url.split("/")[3]);

// 1. The happy path: Firefox kept every window itself -- do not touch the file.
{
	const snapshot = { windows: [win("a"), win("b"), win("c")] };
	const final = { windows: [win("a"), win("b"), win("c")], session: { state: "stopped" } };
	const r = repairSession(final, snapshot, NOW);
	check("untouched when all windows survived", !r.changed && names(r.state).length === 3, r.note);
}

// 2. THE bug: 3 windows in, 1 window out, the other two filed as "recently closed"
//    (19-tab and 6-tab windows really were lost this way).
{
	const snapshot = { windows: [win("a"), win("b", 19), win("c", 6)] };
	const final = {
		windows: [win("a")],
		_closedWindows: [closedWin("b", 19, NOW + 200), closedWin("c", 6, NOW + 400)],
		session: { state: "stopped" },
	};
	const r = repairSession(final, snapshot, NOW);
	check("recovers windows Firefox filed as recently-closed", r.changed && names(r.state).length === 3, r.note);
	check("  ...with their tabs intact", r.state.windows.reduce((n, w) => n + w.tabs.length, 0) === 26);
	check("  ...and drains them from _closedWindows", (r.state._closedWindows || []).length === 0);
	check("  ...without the closed-window bookkeeping", r.state.windows.every((w) => !("closedAt" in w) && !("closedId" in w)));
}

// 3. Windows the USER closed earlier are none of our business -- leave them closed.
{
	const snapshot = { windows: [win("a"), win("b")] };
	const final = {
		windows: [win("a")],
		_closedWindows: [closedWin("old", 3, NOW - 600_000), closedWin("b", 2, NOW + 100)],
	};
	const r = repairSession(final, snapshot, NOW);
	check("leaves windows the user closed earlier alone", names(r.state).join(",") === "a,b", r.note);
	check("  ...they stay in the recently-closed list", r.state._closedWindows.length === 1);
}

// 4. Nothing recoverable at quit -> fall back to the snapshot taken before closing.
{
	const snapshot = { windows: [win("a"), win("b"), win("c")], session: { state: "running" } };
	const final = { windows: [win("a")], _closedWindows: [], session: { state: "stopped" } };
	const r = repairSession(final, snapshot, NOW);
	check("falls back to the pre-close snapshot", r.changed && names(r.state).length === 3, r.note);
	check("  ...marked stopped, so Firefox does not treat it as a crash", r.state.session.state === "stopped");
}

// 5. Partial recovery still ends up complete.
{
	const snapshot = { windows: [win("a"), win("b"), win("c")] };
	const final = { windows: [win("a")], _closedWindows: [closedWin("b", 1, NOW + 100)] };
	const r = repairSession(final, snapshot, NOW);
	check("tops up from the snapshot when recovery is partial", names(r.state).length === 3, r.note);
}

// 6. No snapshot at all: never make things worse.
{
	const final = { windows: [win("a")], _closedWindows: [] };
	const r = repairSession(final, null, NOW);
	check("no snapshot -> leaves the session as Firefox wrote it", !r.changed && names(r.state).length === 1, r.note);
}

// 7. The container the repaired state gets written back into.
{
	const file = path.join(os.tmpdir(), `session-roundtrip-${process.pid}.jsonlz4`);
	const state = { windows: [win("a", 40)], _closedWindows: [], session: { state: "stopped" } };
	mozlz4.write(file, JSON.stringify(state));
	const back = JSON.parse(mozlz4.read(file));
	check("mozLz4 round-trips a session file", JSON.stringify(back) === JSON.stringify(state));
	check("  ...and looks like one to Firefox", fs.readFileSync(file).subarray(0, 8).toString("latin1") === "mozLz40\0");
	fs.unlinkSync(file);
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
