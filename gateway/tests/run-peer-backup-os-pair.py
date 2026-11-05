"""Exercise two native restic builds and independent escrow across existing SSH transports."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import zipfile
import tempfile
import time
import uuid

parser = argparse.ArgumentParser()
for field in (
    "windows",
    "windows-key",
    "windows-root",
    "restic-windows",
):
    parser.add_argument("--" + field, required=True)
parser.add_argument("--ubuntu")
parser.add_argument("--ubuntu-key")
parser.add_argument("--ubuntu-root", "--source-root", required=True)
parser.add_argument("--restic-linux", "--restic-posix", required=True, help="Pinned native source restic bzip2 archive.")
parser.add_argument("--local-mac", action="store_true", help="Capture on this Mac and recover on Windows.")
parser.add_argument("--windows-job-mib", type=int, help="Optional OS job private commit ceiling for a constrained Windows host.")
parser.add_argument("--windows-job-root", default="C:/harness/packages/subprocess/win32-process")
parser.add_argument("--receipt")
parser.add_argument(
    "--windows-private-volume", help="Previously attested peer-UUID NTFS volume with isolated PostgreSQL."
)
parser.add_argument(
    "--windows-userdoc-koffi",
    help="Existing receiving Gateway UserDoc Koffi module for write-through NTFS recovery.",
)
parser.add_argument(
    "--published-project",
    help="A fresh published-project-UUID synthetic fixture directly below the dedicated Ubuntu root.",
)
parser.add_argument(
    "--reverse", action="store_true", help="Use Windows as source and Ubuntu for offline recovery."
)
args = parser.parse_args()
sources = Path(__file__).resolve().parents[2]
ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=15"]
scp = ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12"]
if args.local_mac:
    if sys.platform != "darwin" or args.reverse or args.ubuntu or args.ubuntu_key:
        parser.error("--local-mac requires a local macOS source and a Windows receiver")
elif not args.ubuntu or not args.ubuntu_key:
    parser.error("set --ubuntu and --ubuntu-key for an SSH source")
linux = [] if args.local_mac else ["-i", args.ubuntu_key, args.ubuntu]
posix_command = ["/bin/sh", "-c"] if args.local_mac else ssh + linux
win = ["-i", args.windows_key, args.windows]
sandbox = "hgw-peer-test-" + str(uuid.uuid4())
assert args.ubuntu_root.startswith("/") and ".." not in Path(args.ubuntu_root).parts
assert ":" in args.windows_root and all(ch not in args.windows_root for ch in ['"', "'", "\n", "\r"])
if args.windows_job_mib is not None:
    assert 96 <= args.windows_job_mib <= 512
    assert re.fullmatch(r"[A-Za-z]:/[\w./-]+", args.windows_job_root) and ".." not in args.windows_job_root.split("/")
unix = args.ubuntu_root.rstrip("/") + "/" + sandbox
windows = args.windows_root.replace("\\", "/").rstrip("/") + "/" + sandbox
q = shlex.quote


def run(argv, **options):
    return subprocess.run(
        argv,
        check=True,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=options.pop("timeout", 180),
        **options,
    ).stdout.strip()


def ps(script):
    return (
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand "
        + base64.b64encode(("$ErrorActionPreference='Stop';" + script).encode("utf-16-le")).decode()
    )


def transfer(key, host, files, target):
    run(scp + ["-i", key] + [str(file) for file in files] + [host + ":" + target + "/"], timeout=300)


receiver = None
masters = []
linux_created = False
win_created = False
with tempfile.TemporaryDirectory(prefix="hgw-peer-pair-") as scratch:
    local = Path(scratch)
    os.chmod(local, 0o700)

    def save(name, value):
        file = local / name
        file.write_text(json.dumps(value) if isinstance(value, dict) else value)
        file.chmod(0o600)
        return file

    try:
        esbuild = sources / "node_modules/.bin/esbuild"
        for source, name in [
            ("gateway/tests/fixtures/peer-backup-os-pair.ts", "pair.js"),
            ("gateway/src/peer-backup-store-worker.ts", "peer-backup-store-worker.js"),
        ]:
            run(
                [
                    str(esbuild),
                    str(sources / source),
                    "--external:koffi",
                    "--alias:@deepseek-ai/dsh-userdoc-local="
                    + str(sources / "packages/attachment/userdoc-local/lib/types/index.js"),
                    "--bundle",
                    "--format=esm",
                    "--platform=node",
                    "--target=node24",
                    "--outfile=" + str(local / name),
                ]
            )
        package = save("package.json", {"type": "module", "private": True})
        commonFiles = [
            local / "pair.js",
            local / "peer-backup-store-worker.js",
            package,
            save("fixture-owner", sandbox),
        ]
        ids = dict(
            (key, str(uuid.uuid4()))
            for key in ["scopeId", "sourceNodeId", "targetNodeId", "policyId", "organizationId"]
        )
        binding = {**ids, "revision": 1}
        if args.published_project:
            path = Path(args.published_project)
            if (
                args.reverse
                or path.parent != Path(args.ubuntu_root)
                or not re.fullmatch(r"published-project-[0-9a-f-]{36}", path.name)
            ):
                raise ValueError("requires a dedicated Ubuntu-generated project point")
            identity = path.name.removeprefix("published-project-")
            assert str(uuid.UUID(identity)) == identity
            encoded = run(
                posix_command
                + [
                    "cd "
                    + q(str(path))
                    + ' && test "$(cat fixture-owner)" = '
                    + q(identity)
                    + " && cat publication.json"
                ]
            )
            publication = json.loads(encoded)
            binding = publication["policy"]
        append, recover, password = [secrets.token_hex(32) for _ in range(3)]
        conf = {
            "version": 1,
            "synthetic": "hgw-peer-pair-fixture",
            "binding": binding,
            "file": "fixture-" + sandbox + ".bin",
            "seed": secrets.token_hex(32),
            "appendFingerprint": hashlib.sha256(append.encode()).hexdigest(),
            "recoveryFingerprint": hashlib.sha256(recover.encode()).hexdigest(),
        }
        run(
            posix_command
            + [
                "umask 077; mkdir -p "
                + q(args.ubuntu_root)
                + " && mkdir "
                + q(unix)
                + " && printf %s "
                + q(sandbox)
                + " > "
                + q(unix + "/fixture-owner")
            ]
        )
        linux_created = True
        if args.published_project:
            conf["kind"] = "published-project"
            if args.windows_private_volume:
                volume = args.windows_private_volume.replace("\\", "/")
                assert (
                    re.fullmatch("[D-Z]:/peer-[a-f0-9-]{36}", volume, re.I)
                    and args.windows_root.replace("\\", "/") == volume + "/replacement"
                )
                conf["replacement"] = {
                    "privateVolume": volume.replace("/", "\\"),
                    "nameVersion": publication["nameVersion"],
                    "publicId": publication["publicId"],
                }
                physical = local / "physical.js"
                run(
                    [
                        str(esbuild),
                        str(sources / "gateway/tests/fixtures/peer-backup-windows-physical.ts"),
                        "--bundle",
                        "--format=esm",
                        "--platform=node",
                        "--target=node24",
                        "--external:pg",
                        "--external:koffi",
                        "--external:@deepseek-ai/dsh-schedule",
                        "--outfile=" + str(physical),
                    ]
                )
                with zipfile.ZipFile(
                    local / "physical.zip", "w", compression=zipfile.ZIP_DEFLATED
                ) as archive:
                    archive.write(physical, "gateway/lib/physical.js")
                    for sql in sorted((sources / "gateway/deploy/node-content/migrations").glob("*.sql")):
                        archive.write(sql, "gateway/deploy/node-content/migrations/" + sql.name)
                commonFiles.append(local / "physical.zip")
            run(
                posix_command
                + [
                    'test "$(cat '
                    + q(str(path / "fixture-owner"))
                    + ')" = '
                    + q(identity)
                    + " && mv -- "
                    + q(str(path))
                    + " "
                    + q(unix + "/published-project")
                ]
            )
        win_created = True
        grant = """$acl=Get-Acl -LiteralPath $dir;$acl.SetAccessRuleProtection($true,$false);
        foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)};
        $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
        foreach($sid in @($owner,'S-1-5-18','S-1-5-32-544')){
          $id=New-Object Security.Principal.SecurityIdentifier($sid);
          $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
        }; Set-Acl -LiteralPath $dir -AclObject $acl"""
        run(
            ssh
            + win
            + [
                ps(
                    "$dir=[IO.Path]::GetFullPath('"
                    + windows
                    + "');if(Test-Path -LiteralPath $dir){throw 'fixture collision'}; "
                    + "New-Item -ItemType Directory -Path $dir -Force|Out-Null;[IO.File]::WriteAllText(($dir+'/fixture-owner'),'"
                    + sandbox
                    + "');"
                    + grant
                )
            ]
        )
        if args.published_project:
            koffi = args.windows_userdoc_koffi
            if (
                not koffi
                or any(ch in koffi for ch in ["'", '"', "\n", "\r"])
                or not koffi.lower().endswith("/node_modules/koffi")
            ):
                raise ValueError(
                    "the published-project test requires the declared Windows UserDoc Koffi installation"
                )
            run(
                ssh
                + win
                + [
                    ps(
                        "$d='"
                        + windows
                        + "';$k='"
                        + koffi
                        + "';if(!(Test-Path -LiteralPath ($k+'/package.json'))){throw 'UserDoc native helper unavailable'};"
                        + "New-Item -ItemType Directory -Path ($d+'/node_modules')|Out-Null;New-Item -ItemType Junction -Path ($d+'/node_modules/koffi') -Target $k|Out-Null"
                    )
                ]
            )
        windows_files = commonFiles + [Path(args.restic_windows)]
        if args.windows_job_mib:
            windows_files.append(sources / "gateway/tests/fixtures/peer-backup-windows-budget.mjs")
        transfer(args.windows_key, args.windows, windows_files, windows)
        if args.local_mac:
            for file in commonFiles + [Path(args.restic_linux)]:
                shutil.copyfile(file, Path(unix) / file.name)
        else:
            transfer(args.ubuntu_key, args.ubuntu, commonFiles + [Path(args.restic_linux)], unix)
        linux_archive = Path(args.restic_linux).name
        windows_archive = Path(args.restic_windows).name
        run(
            posix_command
            + [
                "cd "
                + q(unix)
                + " && umask 077 && bzip2 -dc -- "
                + q(linux_archive)
                + " > restic && chmod 700 restic"
            ]
        )
        run(
            ssh
            + win
            + [
                ps(
                    "$d='"
                    + windows
                    + "'; Expand-Archive -LiteralPath ($d+'/"
                    + windows_archive
                    + "') -DestinationPath ($d+'/bin'); "
                    + "$x=@(Get-ChildItem ($d+'/bin') -Recurse -File -Filter '*.exe');if($x.Count-ne 1){throw 'unexpected restic archive'}; "
                    + "Move-Item -LiteralPath $x[0].FullName -Destination ($d+'/restic.exe')"
                )
            ]
        )
        if args.windows_private_volume:
            run(
                ssh
                + win
                + [
                    ps(
                        "$d='"
                        + windows
                        + "';Expand-Archive -LiteralPath ($d+'/physical.zip') -DestinationPath $d;"
                        + "$p='C:/harness/gateway/node_modules/pg';if(!(Test-Path -LiteralPath ($p+'/package.json'))){throw 'Missing installed PG client'};"
                        + "New-Item -ItemType Junction -Path ($d+'/node_modules/pg') -Target $p|Out-Null"
                    )
                ]
            )
        recv_os = "linux" if args.reverse else "win32"
        send_os = "win32" if args.reverse else "linux"
        hosts = {"linux": linux, "win32": win}
        locations = {"linux": unix, "win32": windows}
        exes = {"linux": unix + "/restic", "win32": windows.replace("/", "\\") + "\\restic.exe"}

        def upload(os_id, files):
            key, host = (
                (args.ubuntu_key, args.ubuntu) if os_id == "linux" else (args.windows_key, args.windows)
            )
            if os_id == "linux" and args.local_mac:
                for file in files:
                    shutil.copyfile(file, Path(unix) / file.name)
            else:
                transfer(key, host, files, locations[os_id])
            if os_id == "linux":
                run(posix_command + ["cd " + q(unix) + " && chmod 600 " + " ".join(q(f.name) for f in files)])

        sys_node = shutil.which("node") if args.local_mac else "/usr/bin/node"
        if not sys_node:
            raise RuntimeError("source Node executable unavailable")

        def invoke(os_id, action):
            if os_id == "linux":
                return (
                    posix_command + ["cd " + q(unix) + " && " + q(sys_node) + " pair.js " + action + " " + action + ".json"]
                )
            return (
                ssh
                + win
                + [
                    ps(
                        "$d='"
                        + windows
                        + "';"
                        + (("$env:HGW_TEST_WINDOWS_JOB_MIB='" + str(args.windows_job_mib) + "';"
                           + "$env:HGW_TEST_WINDOWS_JOB_ROOT='" + args.windows_job_root + "'; & node --max-old-space-size=64 --import (New-Object uri ($d+'/peer-backup-windows-budget.mjs')).AbsoluteUri ")
                           if args.windows_job_mib else "& node ")
                        + "($d+'/pair.js') "
                        + action
                        + " ($d+'/"
                        + action
                        + ".json');exit $LASTEXITCODE"
                    )
                ]
            )

        upload(recv_os, [save("receive.json", {k: v for k, v in conf.items() if k != "seed"})])
        receiver = subprocess.Popen(
            invoke(recv_os, "receive"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
        )
        import select

        if not select.select([receiver.stdout], [], [], 95)[0]:
            raise RuntimeError("receiver listener readiness timed out")
        ready_line = receiver.stdout.readline().strip()
        if not ready_line:
            raise RuntimeError(
                "receiver did not open its loopback listener: " + receiver.stderr.read()[:1800]
            )
        ready = json.loads(ready_line)
        port = int(ready["port"])
        with socket.socket() as free:
            free.bind(("127.0.0.1", 0))
            local_port = free.getsockname()[1]
        recv_ctl = str(local / "recv.sock")
        send_ctl = str(local / "send.sock")
        run(
            ssh
            + [
                "-M",
                "-S",
                recv_ctl,
                "-fNT",
                "-o",
                "ExitOnForwardFailure=yes",
                "-L",
                f"127.0.0.1:{local_port}:127.0.0.1:{port}",
            ]
            + hosts[recv_os]
        )
        masters.append((recv_ctl, hosts[recv_os]))
        remote_port = local_port
        if not args.local_mac:
            run(ssh + ["-M", "-S", send_ctl, "-fNT", "-o", "ExitOnForwardFailure=yes"] + hosts[send_os])
            masters.append((send_ctl, hosts[send_os]))
            remote_port = int(
                run(
                    ssh
                    + ["-S", send_ctl, "-O", "forward", "-R", f"127.0.0.1:0:127.0.0.1:{local_port}"]
                    + hosts[send_os]
                )
            )
        upload(
            send_os,
            [
                save(
                    "send.json",
                    {**conf, "restic": exes[send_os], "origin": "http://127.0.0.1:" + str(remote_port)},
                ),
                save("append.token", append),
                save("source.key", password),
            ],
        )
        captured = json.loads(run(invoke(send_os, "send"), timeout=240).splitlines()[-1])
        receiver.stdin.write("close\n")
        receiver.stdin.flush()
        _, err = receiver.communicate(timeout=50)
        if receiver.returncode:
            raise RuntimeError("receiver failed to durably close: " + err[:1000])
        receiver = None
        for control, host in reversed(masters):
            run(ssh + ["-S", control, "-O", "exit"] + host)
        masters.clear()
        upload(
            recv_os,
            [
                save("verify.json", {**conf, "restic": exes[recv_os], "pointId": captured["pointId"]}),
                save("recovery.key", password),
            ],
        )
        offline_started = time.monotonic()
        checked = json.loads(run(invoke(recv_os, "verify"), timeout=360).splitlines()[-1])
        checked["offlineCommandMs"] = round((time.monotonic() - offline_started) * 1000)
        if (
            not captured["idempotent"]
            or not captured["syntheticSourceRemoved"]
            or (not args.published_project and checked["watermark"] != "2")
            or checked["remainingGaps"] != 0
            or (args.published_project and not checked.get("documentIdentityRebound"))
            or (args.windows_private_volume and not checked.get("sourceOfflineWriteDenied"))
        ):
            raise RuntimeError("incomplete synthetic recovery")
        result = {
            "synthetic": True,
            "transport": ("Mac to Windows loopback SSH forward, disconnected before offline recovery" if args.local_mac
                          else "two SSH loopback forwards, disconnected before offline recovery"),
            "capture": captured,
            "recovery": checked,
        }
        if args.windows_job_mib:
            result["windowsResources"] = json.loads(run(ssh + win + [ps(
                "$d='" + windows + "';@(Get-ChildItem -LiteralPath $d -File -Filter '*-budget.json'|ForEach-Object{"
                "[pscustomobject]@{stage=$_.BaseName;usage=([IO.File]::ReadAllText($_.FullName)|ConvertFrom-Json)}})|ConvertTo-Json -Compress -Depth 4"
            )]))
        if args.receipt:
            Path(args.receipt).write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    except subprocess.CalledProcessError as err:
        print((err.stderr or "")[:1800], file=sys.stderr)
        raise SystemExit("A test-only command failed with exit code " + str(err.returncode))
    finally:
        if receiver and receiver.poll() is None:
            try:
                receiver.communicate("close\n", timeout=15)
            except (subprocess.TimeoutExpired, BrokenPipeError):
                receiver.terminate()
                receiver.wait()
        for control, host in reversed(masters):
            subprocess.run(ssh + ["-S", control, "-O", "exit"] + host, capture_output=True, timeout=15)
        # Delete only the unique fixture directory with the exact marker written by this process.
        if linux_created:
            subprocess.run(
                posix_command
                + [
                    "cd "
                    + q(unix)
                    + ' && test "$(cat fixture-owner)" = '
                    + q(sandbox)
                    + " && cd / && rm -rf -- "
                    + q(unix)
                ],
                capture_output=True,
                timeout=25,
            )
        if win_created:
            subprocess.run(
                ssh
                + win
                + [
                    ps(
                        "$d='"
                        + windows
                        + "';if((Get-Content -Raw -LiteralPath ($d+'/fixture-owner')) -eq '"
                        + sandbox
                        + "'){foreach($node in @('koffi','pg')){$j=$d+'/node_modules/'+$node;if(Test-Path -LiteralPath $j){[IO.Directory]::Delete($j)}};Remove-Item -LiteralPath $d -Recurse -Force}"
                    )
                ],
                capture_output=True,
                timeout=25,
            )
