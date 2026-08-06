# Regression test for the --restart path of scripts/install_local.js.
#
# Pins two bugs that each ate browser windows:
#  1. `taskkill /PID` posts WM_CLOSE to the *main* window only, so one window
#     vanished and the browser stayed running (update never applied).
#  2. Closing windows one at a time is not a quit: Firefox files every window
#     that closes while another is still open under "recently closed windows",
#     and restore only brings back state.windows -- so 3 windows came back as 1.
#     install_local promotes those back before relaunching; this test counts
#     windows before and after and fails if any went missing.
#
# Runs entirely on a THROWAWAY profile (--profile is honoured by install_local),
# so the user's own Firefox is never touched.
#
#   python scripts/test_restart.py

import json, os, pathlib, shutil, subprocess, sys, tempfile, time
sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"

results = []
def check(label, cond, extra=""):
    results.append(bool(cond))
    print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

def ps(script):
    r = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                       capture_output=True, text=True)
    return (r.stdout or "").strip()

def firefox_pids(profile):
    out = ps("Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | "
             "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress")
    if not out:
        return []
    try:
        data = json.loads(out)
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]
    key = str(profile).lower()
    return [d["ProcessId"] for d in data
            if d.get("CommandLine") and key in d["CommandLine"].lower()
            and "-contentproc" not in d["CommandLine"]]

def window_count(pids):
    if not pids:
        return 0
    return int(ps(
        "Add-Type @\"\nusing System;using System.Runtime.InteropServices;\n"
        "public class T{public delegate bool E(IntPtr h,IntPtr l);"
        "[DllImport(\"user32.dll\")]public static extern bool EnumWindows(E c,IntPtr l);"
        "[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);"
        "[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);"
        "[DllImport(\"user32.dll\")]public static extern IntPtr GetWindow(IntPtr h,uint c);}\n\"@\n"
        f"$set=@{{}};foreach($p in @({','.join(map(str,pids))})){{$set[[uint32]$p]=$true}}\n"
        "$n=0;$cb=[T+E]{param($h,$l);$q=[uint32]0;"
        "[void][T]::GetWindowThreadProcessId($h,[ref]$q);"
        "if($set.ContainsKey($q) -and [T]::IsWindowVisible($h) -and "
        "[T]::GetWindow($h,4) -eq [IntPtr]::Zero){$script:n++};return $true}\n"
        "[void][T]::EnumWindows($cb,[IntPtr]::Zero);$n") or 0)

def session_state(profile):
    """Decode whichever session file the running Firefox has written."""
    sys.path.insert(0, str(ROOT / "scripts"))
    for rel in ("sessionstore-backups/recovery.jsonlz4", "sessionstore.jsonlz4"):
        f = pathlib.Path(profile) / rel
        if f.exists():
            out = subprocess.run(
                ["node", "-e",
                 "const m=require('./scripts/lib/mozlz4.js');"
                 "process.stdout.write(m.read(process.argv[1]))", str(f)],
                capture_output=True, text=True, cwd=str(ROOT))
            if out.returncode == 0 and out.stdout:
                try:
                    return json.loads(out.stdout)
                except Exception:
                    pass
    return {}


if not os.path.exists(FIREFOX):
    print("SKIP  Firefox not found at", FIREFOX); sys.exit(0)

profile = pathlib.Path(tempfile.mkdtemp(prefix="archiver-restart-"))
# Throwaway profiles otherwise open the "Welcome to Firefox" modal over whatever
# the user is doing.
(profile / "user.js").write_text(
    'user_pref("browser.aboutwelcome.enabled", false);\n'
    'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("browser.startup.homepage_override.mstone", "ignore");\n',
    encoding="utf-8")
try:
    # Three windows on one instance -- the shape the user actually hit.
    # The pages must be REAL: Firefox does not keep a closed window in its
    # "recently closed" history if every tab is about:blank/about:newtab, so a
    # harness built on about: pages silently tests nothing.
    pages = []
    for i in (1, 2, 3):
        f = profile / f"page{i}.html"
        f.write_text(f"<title>harness page {i}</title><h1>page {i}</h1>", encoding="utf-8")
        pages.append(f.as_uri())

    subprocess.Popen([FIREFOX, "-profile", str(profile), "-no-remote",
                      "-new-window", pages[0]])
    time.sleep(12)
    for url in pages[1:]:
        subprocess.Popen([FIREFOX, "-profile", str(profile), "-no-remote",
                          "-new-window", url])
        time.sleep(8)

    pids = firefox_pids(profile)
    check("throwaway Firefox is running", bool(pids), f"pids={pids}")
    wins = window_count(pids)
    check("it has more than one window", wins >= 2, f"windows={wins}")

    if pids and wins >= 2:
        r = subprocess.run(["npm", "run", "install:local", "--",
                            "--restart", f"--profile={profile}", "--force"],
                           capture_output=True, text=True, shell=True, cwd=str(ROOT))
        out = (r.stdout or "") + (r.stderr or "")
        print("\n".join("    | " + l for l in out.strip().splitlines()[-8:]))

        tail = out.strip().splitlines()[-6:]
        check("script reported the real window count", f"{wins} window(s)" in out, " / ".join(tail))
        time.sleep(6)
        # THE regression check: the ORIGINAL instance must be gone. Before the
        # fix it survived, having lost only its main window.
        survivors = [p for p in firefox_pids(profile) if p in pids]
        check("the whole browser exited, not just one window", not survivors, f"original pids still alive: {survivors}")
        check("script says it reopened", "reopened" in out.lower(), " / ".join(tail))
        time.sleep(20)
        back = firefox_pids(profile)
        check("Firefox came back up", bool(back), f"pids={back}")
        # THE session check: every window must return, not just the last one closed.
        got = window_count(back)
        check("every window came back", got >= wins, f"before={wins} after={got}")
        state = session_state(profile)
        tabs = sum(len(w.get("tabs", [])) for w in state.get("windows", []))
        check("the restored session holds all windows",
              len(state.get("windows", [])) >= wins,
              f"windows={len(state.get('windows', []))} tabs={tabs}")
finally:
    for pid in firefox_pids(profile):
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    time.sleep(3)
    shutil.rmtree(profile, ignore_errors=True)

print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"))
sys.exit(0 if all(results) else 1)
