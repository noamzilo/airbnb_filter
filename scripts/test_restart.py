# Regression test for the --restart path of scripts/install_local.js.
#
# Reproduces the bug that ate a browser window: with MORE THAN ONE Firefox
# window open, `taskkill /PID` posts WM_CLOSE to the main window only, so one
# window vanishes and the browser stays running.
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

if not os.path.exists(FIREFOX):
    print("SKIP  Firefox not found at", FIREFOX); sys.exit(0)

profile = pathlib.Path(tempfile.mkdtemp(prefix="archiver-restart-"))
try:
    # Two windows on one instance -- the case that broke.
    subprocess.Popen([FIREFOX, "-profile", str(profile), "-no-remote",
                      "-new-window", "about:blank"])
    time.sleep(12)
    subprocess.Popen([FIREFOX, "-profile", str(profile), "-no-remote",
                      "-new-window", "about:robots"])
    time.sleep(10)

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
        time.sleep(12)
        back = firefox_pids(profile)
        check("Firefox came back up", bool(back), f"pids={back}")
        check("its windows came back", window_count(back) >= 1, f"windows={window_count(back)}")
finally:
    for pid in firefox_pids(profile):
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    time.sleep(3)
    shutil.rmtree(profile, ignore_errors=True)

print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"))
sys.exit(0 if all(results) else 1)
