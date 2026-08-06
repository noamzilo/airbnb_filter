// Install the freshly signed .xpi straight into the real Firefox profile, so no
// manual "about:addons -> Install Add-on From File..." dance is needed.
//
// How it works: Firefox scans <profile>/extensions/<addon-id>.xpi at startup and
// installs/upgrades whatever it finds there ("app-profile" location -- the same
// location a manual install-from-file ends up in). Dropping a newer signed .xpi
// there is therefore an in-place upgrade: same add-on id, same storage keys, so
// the user's starred / maybe / archived / notes / order all survive.
//
// The running Firefox keeps the OLD copy open (the file is opened FILE_SHARE_DELETE,
// so replacing it while Firefox runs is safe); the new version becomes active at the
// next Firefox restart. Pass --restart to do that restart here -- WITHOUT losing tabs:
// close gracefully so Firefox writes its session, arm browser.sessionstore.
// resume_session_once (the one-shot pref Firefox itself uses when it restarts for an
// update), reopen. Nothing is ever force-killed.
//
// Usage:
//   node scripts/install_local.js                 # newest signed xpi -> default profile
//   node scripts/install_local.js --restart       # ...and restart Firefox, tabs kept
//   node scripts/install_local.js --xpi=path.xpi --profile=default-release
//   node scripts/install_local.js --force         # skip the version-match guard

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ARTIFACTS = path.join(ROOT, "web-ext-artifacts");

const args = process.argv.slice(2);
const flag = (name) => {
	const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) return null;
	return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const die = (msg) => {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
};

// ---------------------------------------------------------------- the add-on
const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"),
);
const addonId = manifest.browser_specific_settings?.gecko?.id;
if (!addonId) die("no browser_specific_settings.gecko.id in extension/manifest.json");

// ------------------------------------------------------------------ the .xpi
function newestXpi() {
	if (!fs.existsSync(ARTIFACTS)) die(`no ${ARTIFACTS} -- run \`npm run sign\` first`);
	const xpis = fs
		.readdirSync(ARTIFACTS)
		.filter((f) => f.endsWith(".xpi"))
		.map((f) => path.join(ARTIFACTS, f))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	if (!xpis.length) die("no .xpi in web-ext-artifacts -- run `npm run sign` first");
	return xpis[0];
}

const explicitXpi = typeof flag("xpi") === "string" ? flag("xpi") : null;
const xpi = path.resolve(explicitXpi || newestXpi());
if (!fs.existsSync(xpi)) die(`no such file: ${xpi}`);

const blob = fs.readFileSync(xpi);
// Zip entry names sit in the archive as plain bytes, so this is a dependency-free
// "is it AMO-signed?" check. An unsigned xpi would be rejected/disabled by Firefox.
if (!blob.includes("META-INF/mozilla.rsa")) {
	die(`${path.basename(xpi)} is not signed (no META-INF/mozilla.rsa) -- run \`npm run sign\``);
}
// Guard against silently re-installing (or downgrading to) an older build: signed
// artifacts are named <hash>-<version>.xpi.
if (!explicitXpi && !flag("force") && !path.basename(xpi).endsWith(`-${manifest.version}.xpi`)) {
	die(
		`newest artifact is ${path.basename(xpi)} but extension/manifest.json says ` +
			`${manifest.version} -- sign the current version first (or pass --force/--xpi=...)`,
	);
}

// --------------------------------------------------------------- the profile
function firefoxRoot() {
	const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
	return path.join(appdata, "Mozilla", "Firefox");
}

function parseIni(text) {
	const sections = [];
	let cur = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;
		const head = line.match(/^\[(.+)\]$/);
		if (head) {
			cur = { name: head[1], keys: {} };
			sections.push(cur);
			continue;
		}
		const eq = line.indexOf("=");
		if (cur && eq > 0) cur.keys[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return sections;
}

function resolveProfile(want) {
	const root = firefoxRoot();
	const iniPath = path.join(root, "profiles.ini");
	if (!fs.existsSync(iniPath)) die(`no Firefox profiles.ini at ${iniPath}`);
	const sections = parseIni(fs.readFileSync(iniPath, "utf8"));
	const profiles = sections.filter((s) => /^Profile\d+$/.test(s.name));

	const toPath = (p, isRelative) =>
		isRelative === "0" ? p : path.join(root, p.replace(/\//g, path.sep));

	if (want && want !== true) {
		if (fs.existsSync(want)) return path.resolve(want); // full path given
		const hit = profiles.find((p) => p.keys.Name === want || p.keys.Path?.endsWith(want));
		if (!hit) die(`no profile named "${want}" in profiles.ini`);
		return toPath(hit.keys.Path, hit.keys.IsRelative);
	}

	// The [InstallXXXX] section is *this* Firefox install's default profile -- the one
	// that actually opens when the user launches Firefox. It wins over Default=1.
	const install = sections.find((s) => s.name.startsWith("Install") && s.keys.Default);
	if (install) return toPath(install.keys.Default, "1");
	const dflt = profiles.find((p) => p.keys.Default === "1");
	if (!dflt) die("could not determine the default Firefox profile");
	return toPath(dflt.keys.Path, dflt.keys.IsRelative);
}

const profileDir = resolveProfile(flag("profile"));
if (!fs.existsSync(profileDir)) die(`profile dir does not exist: ${profileDir}`);

// Best-effort: what version is installed right now?
function installedVersion() {
	try {
		const db = JSON.parse(
			fs.readFileSync(path.join(profileDir, "extensions.json"), "utf8"),
		);
		return db.addons.find((a) => a.id === addonId)?.version || null;
	} catch {
		return null;
	}
}
const before = installedVersion();
// Signed artifacts are named <hash>-<version>.xpi; trust the file over the manifest
// so an explicit --xpi=<older build> reports what it actually installs.
const version = path.basename(xpi).match(/-(\d+(?:\.\d+)*)\.xpi$/)?.[1] || manifest.version;

// ------------------------------------------------------------------- install
const extDir = path.join(profileDir, "extensions");
fs.mkdirSync(extDir, { recursive: true });
const target = path.join(extDir, `${addonId}.xpi`);
const staged = path.join(extDir, `.${addonId}.xpi.new`);
const tombstone = path.join(extDir, `.${addonId}.xpi.old`);
const rm = (p) => {
	try {
		fs.unlinkSync(p);
	} catch {
		/* still open by Firefox -- cleaned up on a later run */
	}
};

rm(staged);
rm(tombstone);
fs.copyFileSync(xpi, staged);
// A running Firefox holds the installed .xpi open, so it cannot be *overwritten*
// (rename-onto fails EPERM) -- but it CAN be renamed out of the way, because Firefox
// opens it FILE_SHARE_DELETE. So: move the old one aside, move the new one in, then
// drop the old one (the unlink only lands once Firefox lets go, hence best-effort).
if (fs.existsSync(target)) fs.renameSync(target, tombstone);
try {
	fs.renameSync(staged, target);
} catch (e) {
	if (fs.existsSync(tombstone) && !fs.existsSync(target)) fs.renameSync(tombstone, target);
	die(`could not write ${target}: ${e.message}`);
}
rm(tombstone);

// ---------------------------------------------------------- running instances
// Parent processes only: content children carry "-contentproc" and die with the parent.
function firefoxProcs() {
	const r = spawnSync(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			"$w = @{}; Get-Process firefox -ErrorAction SilentlyContinue | " +
				"ForEach-Object { $w[[string]$_.Id] = [int64]$_.MainWindowHandle }; " +
				"Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | " +
				"Select-Object ProcessId,CommandLine,ExecutablePath," +
				"@{n='Win';e={$w[[string]$_.ProcessId]}} | ConvertTo-Json -Compress",
		],
		{ encoding: "utf8" },
	);
	let parsed;
	try {
		parsed = JSON.parse((r.stdout || "").trim() || "null");
	} catch {
		return [];
	}
	if (!parsed) return [];
	const all = Array.isArray(parsed) ? parsed : [parsed];
	return all
		.filter((p) => !/-contentproc/i.test(p.CommandLine || ""))
		.map((p) => ({
			pid: p.ProcessId,
			cmd: p.CommandLine || "",
			exe: p.ExecutablePath || null,
			hasWindow: Boolean(p.Win),
		}));
}

// If --profile was given, only touch the instance running THAT profile -- so a test
// run can never take down the user's normal browser.
const wantedProfile = flag("profile");
const procs = firefoxProcs().filter(
	(p) => !wantedProfile || p.cmd.toLowerCase().includes(profileDir.toLowerCase()),
);

console.log(`installed: ${path.basename(xpi)}`);
console.log(`       id: ${addonId}`);
console.log(`  version: ${before ? `${before} -> ` : ""}${version}`);
console.log(`  profile: ${profileDir}`);

// ------------------------------------------------------------------- restart
function firefoxExe() {
	const fromProc = procs.find((p) => p.exe && fs.existsSync(p.exe))?.exe;
	if (fromProc) return fromProc;
	// Forward slashes: in a JS string "\P"/"\M" silently drop the backslash and
	// "\f" is a formfeed, so the backslashed form never matched anything.
	for (const p of [
		"C:/Program Files/Mozilla Firefox/firefox.exe",
		"C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
	]) {
		if (fs.existsSync(p)) return p;
	}
	return null;
}

const sleep = (ms) =>
	spawnSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`]);

// Every top-level window belonging to these pids. `taskkill /PID` (and
// Get-Process MainWindowHandle) only ever reach ONE window per process, so on a
// Firefox with several windows open it closes a single window and the browser
// stays up -- which looks exactly like "it ate my window and never restarted".
const WINDOW_PS = `
param([int[]]$Pids)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ArchiverWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$set = @{}; foreach ($p in $Pids) { $set[[uint32]$p] = $true }
$found = New-Object System.Collections.ArrayList
$cb = [ArchiverWin+EnumProc]{
  param($h, $l)
  $pid2 = [uint32]0
  [void][ArchiverWin]::GetWindowThreadProcessId($h, [ref]$pid2)
  # visible, and an owner-less top-level window (GW_OWNER = 4) -- i.e. a real
  # browser window, not a tooltip or a modal's shadow.
  if ($set.ContainsKey($pid2) -and [ArchiverWin]::IsWindowVisible($h) -and
      [ArchiverWin]::GetWindow($h, 4) -eq [IntPtr]::Zero) { [void]$found.Add($h) }
  return $true
}
[void][ArchiverWin]::EnumWindows($cb, [IntPtr]::Zero)
if ($env:ARCHIVER_CLOSE -eq '1') {
  foreach ($h in $found) { [void][ArchiverWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
}
$found.Count
`;
function windowScript(pids, close) {
	const f = path.join(os.tmpdir(), `archiver-win-${process.pid}.ps1`);
	fs.writeFileSync(f, WINDOW_PS);
	const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f, "-Pids", pids.join(",")], {
		encoding: "utf8",
		env: { ...process.env, ARCHIVER_CLOSE: close ? "1" : "0" },
	});
	rm(f);
	const n = parseInt((r.stdout || "").trim().split(/\s+/).pop(), 10);
	return Number.isFinite(n) ? n : 0;
}
const countWindows = (pids) => windowScript(pids, false);
const closeAllWindows = (pids) => windowScript(pids, true);

function waitForExit(pids, ms) {
	const deadline = Date.now() + ms;
	const alive = () => {
		const live = new Set(firefoxProcs().map((p) => p.pid));
		return pids.filter((pid) => live.has(pid));
	};
	while (Date.now() < deadline) {
		if (!alive().length) return true;
		sleep(500);
	}
	return false;
}

// Firefox only restores tabs on startup if browser.startup.page == 3, which is NOT the
// default. browser.sessionstore.resume_session_once is the one-shot pref Firefox itself
// sets when it restarts for an update: next startup restores the session, then Firefox
// clears the pref. Must be written AFTER shutdown -- Firefox rewrites prefs.js on exit.
function armSessionRestore() {
	const prefsPath = path.join(profileDir, "prefs.js");
	if (!fs.existsSync(prefsPath)) return "no prefs.js -- cannot arm session restore";
	const prefs = fs.readFileSync(prefsPath, "utf8");
	if (/user_pref\("browser\.startup\.page",\s*3\)/.test(prefs)) {
		return "browser.startup.page=3 (Firefox already restores the session)";
	}
	const kept = prefs
		.split(/\r?\n/)
		.filter((l) => !l.includes("browser.sessionstore.resume_session_once"));
	while (kept.length && kept[kept.length - 1] === "") kept.pop();
	kept.push('user_pref("browser.sessionstore.resume_session_once", true);', "");
	fs.writeFileSync(prefsPath, kept.join("\n"));
	return "armed browser.sessionstore.resume_session_once";
}

// Reopen the way it was opened, minus any URLs it happened to be launched with.
function relaunchArgs(cmd) {
	const out = [];
	const m = cmd.match(/-(?:-)?profile\s+"([^"]+)"|-(?:-)?profile\s+(\S+)/i);
	if (m) out.push("-profile", m[1] || m[2]);
	if (/-(?:-)?no-remote\b/i.test(cmd)) out.push("-no-remote");
	if (/-(?:-)?headless\b/i.test(cmd)) out.push("-headless");
	const pm = cmd.match(/\s-P\s+"([^"]+)"|\s-P\s+(\S+)/);
	if (pm) out.push("-P", pm[1] || pm[2]);
	return out;
}

if (!procs.length) {
	console.log("\nFirefox is not running -- the new version loads next time you open it.");
} else if (!flag("restart")) {
	console.log("\nFirefox is running: it keeps the OLD version until you restart it.");
	console.log(`Restart Firefox (or re-run with --restart) to activate ${version}.`);
} else {
	const exe = firefoxExe();
	const args = relaunchArgs(procs[0].cmd);
	const pids = procs.map((p) => p.pid);
	// taskkill without /F posts WM_CLOSE to every top-level window, which is what makes
	// Firefox shut down cleanly and write its session. A process with no window (headless,
	// or Firefox's launcher stub) has nothing to post to -- say so instead of hanging.
	if (!procs.some((p) => p.hasWindow)) {
		console.log("\nFirefox is running but has no window (headless?) -- it cannot be asked");
		console.log("to close gracefully, and forcing it would risk the session. Left alone;");
		console.log(`${version} activates the next time it starts.`);
		process.exit(0);
	}
	const nWindows = countWindows(pids);
	console.log(`\nclosing Firefox (pid ${pids.join(", ")}, ${nWindows} window(s)) -- graceful, no /F...`);
	// WM_CLOSE to EVERY top-level window == clicking X on each one, so Firefox
	// shuts down cleanly and writes its session. Closing only the main window
	// (what taskkill does) just destroys one window and leaves the browser up.
	const closed = closeAllWindows(pids);
	if (!closed) {
		console.log("no closable windows found -- left alone; " + version + " loads on your next start.");
		process.exit(0);
	}
	if (!waitForExit(pids, 45000)) {
		console.log(`Firefox did not exit within 45s -- a dialog is probably blocking shutdown`);
		console.log(`(an "unsaved changes"/"leave site?" prompt on some tab).`);
		console.log(`Nothing was forced. ${closed} window(s) were asked to close -- press`);
		console.log(`Ctrl+Shift+N in Firefox to reopen any that did close, then restart it`);
		console.log(`yourself to activate ${version}.`);
		process.exit(0);
	}
	console.log(`session restore: ${armSessionRestore()}`);
	if (!exe) {
		console.log("Firefox closed, but firefox.exe was not found -- start it yourself.");
		process.exit(0);
	}
	spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
	console.log(`reopened Firefox with your tabs -- ${version} is now active.`);
}
