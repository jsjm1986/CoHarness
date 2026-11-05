"""Measure one synthetic POSIX-to-Windows writer switch with private SSH loopback forwards and isolated databases."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import socket
import subprocess
import tempfile
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument(
    "--windows-min-free-mib",
    type=int,
    default=750,
    help="Minimum free physical memory required before starting a receiver.",
)
parser.add_argument(
    "--local-mac",
    action="store_true",
    help="Use the current Mac's disposable Unix-socket PostgreSQL cluster as the original writer.",
)
for option in ("linux", "linux-key", "linux-stage", "restic-linux", "local-pg-bindir", "local-restic"):
    parser.add_argument("--" + option)
for option in ("windows", "windows-key", "windows-volume", "restic-windows", "receipt"):
    parser.add_argument("--" + option, required=True)
args = parser.parse_args()
assert args.windows_min_free_mib >= 750
workspace = Path(__file__).resolve().parents[2]
if args.local_mac:
    assert sys.platform == "darwin" and args.local_pg_bindir and args.local_restic
    assert Path(args.local_pg_bindir, "postgres").is_file() and Path(args.local_restic).is_file()
    template = str(workspace)
else:
    assert args.linux and args.linux_key and args.linux_stage and args.restic_linux
    assert re.fullmatch(r"/tmp/hgw-node-validation-[A-Za-z0-9]+/peer/suite\.[A-Za-z0-9]+", args.linux_stage)
    template = args.linux_stage
volume = args.windows_volume.replace("\\", "/")
assert re.fullmatch(r"[D-Z]:/peer-[a-f0-9-]{36}", volume, re.I)
current = str(uuid.uuid4())
remote_root = (
    (str(Path(tempfile.gettempdir()).resolve()) if args.local_mac else template.rsplit("/", 1)[0])
    + "/hgw-peer-online-source-"
    + current
)
exchange = remote_root + "/" + current
stage = str(workspace) if args.local_mac else remote_root + "/source"
win = volume + "/replacement/hgw-peer-online-" + current
ssh = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=9",
    "-o",
    "ServerAliveInterval=9",
    "-o",
    "ServerAliveCountMax=3",
]
scp = ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=9"]
linux = ["-i", args.linux_key, args.linux]
windows = ["-i", args.windows_key, args.windows]
q = shlex.quote


def ps(script):
    code = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script
    return (
        "powershell.exe -NonInteractive -NoProfile -EncodedCommand "
        + base64.b64encode(code.encode("utf-16le")).decode()
    )


def call(argv, timeout=60):
    result = subprocess.run(argv, capture_output=True, timeout=timeout)
    if result.returncode:
        # The private files and account tokens must never be included in logged command lines or stderr.
        raise RuntimeError(
            "Qualification transport failed (" + Path(argv[0]).name + ", exit " + str(result.returncode) + ")"
        )
    return result.stdout.decode(errors="replace").strip()


def source_command(script):
    return ["/bin/sh", "-c", script] if args.local_mac else ssh + linux + [script]


def on_linux(script, timeout=60):
    return call(source_command(script), timeout)


def on_win(script, timeout=60):
    return call(ssh + windows + [ps(script)], timeout)


def get(side, file):
    if side == "linux":
        data = on_linux(
            "if test -f " + q(exchange + "/" + file) + ";then cat " + q(exchange + "/" + file) + ";fi"
        )
    else:
        data = on_win(
            "if(Test-Path -LiteralPath '"
            + win
            + "/"
            + file
            + "'){[IO.File]::ReadAllText('"
            + win
            + "/"
            + file
            + "')}"
        )
    return json.loads(data) if data else None


def put(side, file, data, private):
    out = private / file
    out.write_text(json.dumps(data))
    out.chmod(0o600)
    if side == "linux":
        dest = exchange + "/" + file
        if args.local_mac:
            shutil.copyfile(out, dest + ".incoming")
            os.chmod(dest + ".incoming", 0o600)
        else:
            call(scp + ["-i", args.linux_key, str(out), args.linux + ":" + dest + ".incoming"])
        on_linux("mv -- " + q(dest + ".incoming") + " " + q(dest))
    else:
        dest = win + "/" + file
        call(scp + ["-i", args.windows_key, str(out), args.windows + ":" + dest + ".incoming"])
        on_win("[IO.File]::Move('" + dest + ".incoming','" + dest + "')")
    out.unlink()


def wait(side, file, process, timeout=490):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = get(side, file)
        if value is not None:
            return value
        if process.poll() is not None:
            raise RuntimeError(side + " worker exited before " + file)
        time.sleep(1)
    raise TimeoutError(side + " did not publish " + file)


def open_forward(control, host, port):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        local = listener.getsockname()[1]
    call(ssh + ["-S", control, "-O", "forward", "-L", f"127.0.0.1:{local}:127.0.0.1:{port}"] + host)
    return local


def reverse_forward(control, host, port):
    return int(call(ssh + ["-S", control, "-O", "forward", "-R", f"127.0.0.1:0:127.0.0.1:{port}"] + host))


with tempfile.TemporaryDirectory(prefix="hgw-peer-online-") as temporary:
    private = Path(temporary)
    masters = []
    processes = []
    opened_linux = False
    opened_windows = False
    start = time.monotonic()
    phases = {}
    previous = start
    phase = "setup"
    source = None
    destination = None

    def resource_check():
        measured = int(
            on_win("[Console]::Write([int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024))")
        )
        if measured < args.windows_min_free_mib:
            raise RuntimeError(
                "Insufficient Windows physical memory for the isolated qualification: "
                + str(measured)
                + " MiB."
            )

    try:
        resource_check()
        if args.local_mac:
            Path(remote_root).mkdir(mode=0o700)
            Path(exchange).mkdir(mode=0o700)
            Path(exchange, "fixture-owner").write_text(current)
            opened_linux = True
        else:
            on_linux(
                "set -eu; test -f "
                + q(template + "/gateway/node_modules/vitest/vitest.mjs")
                + "; mkdir -m700 "
                + q(remote_root)
                + " "
                + q(exchange)
                + " "
                + q(stage)
                + " "
                + q(remote_root + "/provider")
                + "; printf %s "
                + q(current)
                + " > "
                + q(exchange + "/fixture-owner")
            )
            opened_linux = True

            def freeze(local, files, dest):
                archiver = subprocess.Popen(
                    [
                        "tar",
                        "--exclude=._*",
                        "--exclude=.DS_Store",
                        "--exclude=*.js.map",
                        "-C",
                        str(local),
                        "-czf",
                        "-",
                        *files,
                    ],
                    stdout=subprocess.PIPE,
                )
                try:
                    extract = subprocess.run(
                        ssh
                        + linux
                        + ["cd " + q(dest) + " && tar --no-same-owner --warning=no-unknown-keyword -xzf -"],
                        stdin=archiver.stdout,
                        capture_output=True,
                        timeout=120,
                    )
                    archiver.stdout.close()
                    if archiver.wait(timeout=10) or extract.returncode:
                        raise RuntimeError("Cannot freeze private fixture sources.")
                finally:
                    if archiver.poll() is None:
                        archiver.terminate()

            files = [
                "package.json",
                "vitest.shared.ts",
                "gateway/package.json",
                "gateway/src",
                "gateway/tests",
                "gateway/deploy",
                "gateway/vitest.config.ts",
            ]
            files.extend(
                str(f.relative_to(workspace))
                for root in (workspace, workspace / "gateway")
                for f in root.glob("tsconfig*.json")
            )
            freeze(workspace, files, stage)
            freeze(
                workspace / "packages/attachment/userdoc-local/lib/types", ["."], remote_root + "/provider"
            )
            on_linux(
                "set -eu; cd "
                + q(stage)
                + "; ln -s "
                + q(template + "/gateway/node_modules")
                + " gateway/node_modules;"
                + " for d in packages native plugins vendor node_modules;do ln -s "
                + q(template)
                + '/"$d" "$d";done;'
                + "ln -s "
                + q(template + "/node_modules")
                + " "
                + q(remote_root + "/node_modules")
            )
        on_win(
            "$v='"
            + volume
            + "';if([IO.File]::ReadAllText($v+'/fixture-owner') -cne '"
            + volume.split("peer-")[-1]
            + "'){throw 'Wrong QA volume'};"
            + "$d='"
            + win
            + "';New-Item -ItemType Directory -Path $d | Out-Null;[IO.File]::WriteAllText($d+'/fixture-owner','"
            + current
            + "')"
        )
        opened_windows = True
        if not args.local_mac:
            call(
                scp
                + ["-i", args.linux_key, args.restic_linux, args.linux + ":" + remote_root + "/restic.bz2"],
                180,
            )
            on_linux(
                "set -eu; cd "
                + q(remote_root)
                + "; bzip2 -dc restic.bz2 > restic; chmod 700 restic; ./restic version"
            )
        call(
            scp + ["-i", args.windows_key, args.restic_windows, args.windows + ":" + win + "/restic.zip"], 180
        )
        # Build the fixture on Linux. Its root includes the source-verified Windows UserDoc provider and the independent QA development dependencies.
        compile_args = r"""
set -eu
cd "$stage"
b="$tools/node_modules/.bin/esbuild"
if ! test -x "$b";then b="$tools/node_modules/esbuild/bin/esbuild";fi
if ! test -x "$b";then b=$(find -L "$stage/node_modules" -path '*/esbuild/bin/esbuild' -print -quit);fi
test -n "$b" && test -x "$b"
o="$run/bundle";mkdir -p "$o/gateway/lib" "$o/gateway/deploy/node-content"
"$b" gateway/tests/fixtures/peer-backup-windows-takeover.ts --external:pg --external:koffi --external:better-sqlite3 \
 --external:yaml --alias:@deepseek-ai/dsh-userdoc-local="$provider/index.js" --alias:@deepseek-ai/dsh-userdoc="$stage/packages/attachment/userdoc/lib/types/index.js" \
 --bundle --platform=node --format=esm --target=node24 --outfile="$o/gateway/lib/online.js"
"$b" gateway/src/peer-backup-store-worker.ts --bundle --platform=node --format=esm --target=node24 --outfile="$o/gateway/lib/peer-backup-store-worker.js"
cp -R gateway/deploy/node-content/migrations "$o/gateway/deploy/node-content/"
printf '{"type":"module","private":true}\n' > "$o/package.json";cd "$o"
python3 - "$run/package.zip" <<'ZIP'
import os,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'x',zipfile.ZIP_DEFLATED) as z:
 for directory,_,files in os.walk('.'):
  for file in files:
   path=os.path.join(directory,file);z.write(path,os.path.relpath(path))
ZIP
"""
        tools = str(workspace) if args.local_mac else template.rsplit("/peer/", 1)[0] + "/qualification/tools"
        provider = (
            str(workspace / "packages/attachment/userdoc-local/lib/types")
            if args.local_mac
            else remote_root + "/provider"
        )
        on_linux(
            "run="
            + q(remote_root)
            + " stage="
            + q(stage)
            + " tools="
            + q(tools)
            + " provider="
            + q(provider)
            + " sh -s <<'COMPILE'\n"
            + compile_args
            + "\nCOMPILE",
            90,
        )
        archive = private / "package.zip"
        if args.local_mac:
            built = Path(remote_root, "package.zip")
            assert built.stat().st_size < 12 << 20
            built.rename(archive)
        else:
            assert int(on_linux("stat -c %s " + q(remote_root + "/package.zip"))) < 12 << 20
            call(
                scp + ["-i", args.linux_key, args.linux + ":" + remote_root + "/package.zip", str(archive)],
                80,
            )
        call(scp + ["-i", args.windows_key, str(archive), args.windows + ":" + win + "/package.zip"], 100)
        archive.unlink()
        on_win(
            "$d='"
            + win
            + "';Expand-Archive -LiteralPath ($d+'/package.zip') -DestinationPath $d;Expand-Archive -LiteralPath ($d+'/restic.zip') -DestinationPath ($d+'/bin');"
            + "$r=@(Get-ChildItem -LiteralPath ($d+'/bin') -File -Recurse -Filter 'restic*.exe');if($r.Count -ne 1){throw 'Wrong restic distribution'};[IO.File]::Move($r[0].FullName,$d+'/restic.exe');"
            + "New-Item -ItemType Directory -Path ($d+'/node_modules')|Out-Null;"
            + "foreach($name in @('pg','yaml','better-sqlite3','koffi')){$p=if($name -eq 'koffi'){'C:/harness/packages/attachment/userdoc-local/node_modules/koffi'}else{'C:/harness/gateway/node_modules/'+$name};if(!(Test-Path -LiteralPath ($p+'/package.json'))){throw 'Missing read-only QA dependency'};New-Item -ItemType Junction -Path ($d+'/node_modules/'+$name) -Target $p|Out-Null};"
            + "New-Item -ItemType Junction -Path ($d+'/packages') -Target 'C:/harness/packages' | Out-Null",
            90,
        )

        def worker(argv, log):
            target = private / log
            stream = target.open("wb")
            process = subprocess.Popen(argv, stdout=stream, stderr=stream)
            processes.append((process, stream))
            return process

        phases["fixturePreparation"] = round((time.monotonic() - previous) * 1000)
        previous = time.monotonic()
        phase = "source publication"
        pgdir = args.local_pg_bindir if args.local_mac else "/usr/lib/postgresql/16/bin"
        restic = args.local_restic if args.local_mac else remote_root + "/restic"
        source = worker(
            source_command(
                "cd "
                + q(stage)
                + " && HGW_TEST_PG_BINDIR="
                + q(pgdir)
                + " HGW_TEST_RESTIC="
                + q(restic)
                + " HGW_TEST_PEER_TAKEOVER_EXCHANGE="
                + q(exchange)
                + " node gateway/tests/run-node-content-postgres.mjs --recovery"
            ),
            "source.log",
        )
        offer = wait("linux", "offer.json", source, 180)
        assert offer["fixture"] == current and 1024 < int(offer["pgPort"]) <= 65535
        for name, host in (
            [("windows", windows)] if args.local_mac else [("linux", linux), ("windows", windows)]
        ):
            sock = str(private / (name + ".sock"))
            call(ssh + ["-M", "-S", sock, "-fNT", "-o", "ExitOnForwardFailure=yes"] + host)
            masters.append((sock, host))
        ws = masters[-1][0]
        ls = masters[0][0]
        pgport = offer.pop("pgPort")
        offer["controlPort"] = reverse_forward(
            ws, windows, pgport if args.local_mac else open_forward(ls, linux, pgport)
        )
        put("windows", "offer.json", offer, private)
        del offer
        phases["sourceReadyAndTransport"] = round((time.monotonic() - previous) * 1000)
        previous = time.monotonic()
        phase = "receiver admission"
        resource_check()
        destination = worker(
            ssh
            + windows
            + [
                ps(
                    "$d='"
                    + win
                    + "'; Set-Location -LiteralPath $d;& node ($d+'/gateway/lib/online.js') $d;exit $LASTEXITCODE"
                )
            ],
            "target.log",
        )
        port = wait("windows", "receiver.json", destination)
        origin_port = open_forward(ws, windows, port["port"])
        put(
            "linux",
            "receiver.json",
            {"port": origin_port if args.local_mac else reverse_forward(ls, linux, origin_port)},
            private,
        )
        phases["receiverAdmission"] = round((time.monotonic() - previous) * 1000)
        previous = time.monotonic()
        for event, side, other, process in [
            ("captured", "linux", "windows", source),
            ("rehearsed", "windows", "linux", destination),
            ("operation", "linux", "windows", source),
            ("candidate", "windows", "linux", destination),
            ("switched", "linux", "windows", source),
            ("delivered", "windows", "linux", destination),
        ]:
            phase = event
            value = wait(side, event + ".json", process)
            put(other, event + ".json", value, private)
            phases[event] = round((time.monotonic() - previous) * 1000)
            previous = time.monotonic()
        assert value["writable"] and value["epoch"] == "2" and value["newReminderDeliveries"] == 1
        if source.wait(timeout=120) != 0 or destination.wait(timeout=120) != 0:
            raise RuntimeError("A private worker did not close cleanly.")
        output = {
            "source": "darwin" if args.local_mac else "linux",
            "target": "win32",
            "mode": "isolated-online-authorized",
            "busySourceRefused": True,
            "candidateWriteRefused": True,
            "staleSourceWriteRefused": True,
            "wallMs": round((time.monotonic() - start) * 1000),
            "phasesMs": phases,
            "validated": value,
        }
        Path(args.receipt).write_text(json.dumps(output, indent=2) + "\n")
        print(json.dumps(output))
    except Exception as error:
        print("Test stopped during " + phase + ": " + str(error), file=__import__("sys").stderr)
        # Worker diagnostics are already sanitized. Never export the exchange or its disposable DB password.
        for name in ["source.log", "target.log"]:
            file = private / name
            if file.is_file():
                raw = file.read_text(errors="replace")
                for line in raw.splitlines():
                    if re.fullmatch(
                        r"(?:Windows candidate phase |AssertionError|Error: peer-backup/|qualification-failed)[A-Za-z0-9 ./_-]{0,155}",
                        line,
                    ):
                        print(line, file=__import__("sys").stderr)
        raise SystemExit(1)
    finally:
        can_remove = {"linux": source is None, "windows": destination is None}
        for side, was_opened, process, marker in [
            ("linux", opened_linux, source, "source-finished.json"),
            ("windows", opened_windows, destination, "target-finished.json"),
        ]:
            if not was_opened or process is None:
                continue
            if process.poll() is None:
                try:
                    put(side, "abort.json", {"cancelled": True}, private)
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    pass
            deadline = time.monotonic() + 24
            while time.monotonic() < deadline:
                try:
                    if get(side, marker) or process.poll() == 0:
                        can_remove[side] = True
                        break
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    break
                time.sleep(1)
        for sock, host in reversed(masters):
            subprocess.run(ssh + ["-S", sock, "-O", "exit"] + host, capture_output=True, timeout=15)
        for process, stream in processes:
            if process.poll() is None:
                process.terminate()
            stream.close()
        if opened_windows and can_remove["windows"]:
            on_win(
                "$d='"
                + win
                + "';if([IO.File]::ReadAllText($d+'/fixture-owner') -ceq '"
                + current
                + "') {foreach($n in @('node_modules/pg','node_modules/koffi','node_modules/yaml','node_modules/better-sqlite3','packages')){$p=$d+'/'+$n;if(Test-Path -LiteralPath $p){[IO.Directory]::Delete($p)}};Remove-Item -LiteralPath $d -Recurse -Force}",
                100,
            )
        if opened_linux and can_remove["linux"]:
            on_linux(
                'if test "$(cat '
                + q(exchange + "/fixture-owner")
                + ')" = '
                + q(current)
                + ";then rm -rf -- "
                + q(remote_root)
                + ";fi"
            )
