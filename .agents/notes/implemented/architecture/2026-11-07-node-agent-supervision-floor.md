# Agent Note: Node agent supervision floor

Status: implemented

English | [中文](2026-11-07-node-agent-supervision-floor.zh.md)

## Problem

The node agent is the node's only outbound control channel: every remote operation — Runtime RPC, file repair, probe — rides its connection, so a stopped agent makes the whole node unreachable while nothing on the node notices. On Windows the Scheduled Task's `RestartCount 3` applied only to task failure, not to a manual `schtasks /end`, and `/end` followed by `/run` raced `IgnoreNew` and could leave the task stopped forever; a live incident stranded a production node exactly this way. On Linux, `Restart=on-failure` skipped clean `exit 0` exits and left the agent unit weaker than the gateway unit's `always`.

## Decision

`gateway/deploy/windows/node-agent-task.ps1` owns the Windows supervision floor. `-Install` registers a second task, `<TaskName>-watchdog`, on a five-minute repetition; every pass runs `-Watchdog`, which re-runs each watched task whose state is neither `Running` nor `Disabled` and whose last result was not a clean exit. `-AlsoWatch` extends the watched set to peer tasks such as the node's local Gateway task as a single comma-delimited argument — an argv `string[]` would collapse into one literal token through `-File` binding and watch nothing — so a dead sibling cannot strand the node either. `-Restart` is the atomic stop+start form: end, poll until the task provably leaves `Running` or fail loudly, start, poll until it returns — the sequence runs entirely on the node, so a remote caller whose channel drops mid-restart cannot strand the task between the two operations. `Disabled` is honored as a deliberate stop and is never revived, and a `LastTaskResult` of 0 means the process chose to park (terminal refusal or signal-driven stop) and is likewise left alone. The node Gateway's service control invokes `-Restart` through this script, so the admin start action performs a real restart rather than the start-only `schtasks /Run`.

`gateway/deploy/harness-node-agent.service` moves to `Restart=always`, matching the gateway and config units: a clean exit zero can no longer park the channel either. A deliberate `systemctl stop` still stays stopped — the same deliberate-stop semantic the Windows watchdog gives `Disabled`. The broader multi-computer supervision model this floor serves is the one [Windows node enrollment](2026-11-04-windows-node-enrollment.md) registers the task under.

## Alternatives considered

**Run the agent as a Windows Service instead of a Scheduled Task.** SCM failure actions restart on any process exit, which is closer to systemd, but a service wrapper adds install machinery and still neither watches the peer Gateway task nor provides an atomic remote restart path; the watchdog covers both without a new hosting model.

**Let the center detect a dead agent and tell the node to fix itself.** Recovery commands cannot cross a dead channel; supervision must live on the node.

**Watchdog that also verifies the live channel.** A `Running` task that cannot dial — revoked credential, dead tunnel — stays invisible to task state. Detecting that class needs an independent second channel, which is a separate design kept out of this floor.

## Consequences

A manual `schtasks /end` or an exhausted `RestartCount` can no longer leave the node dark for more than one watchdog interval on Windows, and abnormal exits restart under `Restart=always` on Linux and `KeepAlive` on macOS. A clean exit 0 parks everywhere, so a `detached` or `mode-disabled` refusal stops the dial loop instead of re-connecting forever; re-enrollment is an operator act that also starts the unit. Keeping the agent down deliberately uses `Disable-ScheduledTask` or `systemctl stop`, states all supervisors respect. The watchdog task itself is not supervised; removing it is an operator act that removes the floor. `<TaskName>-watchdog` appends only action lines to `<StateRoot>\logs\node-agent-watchdog.log`, so the file stays small. A `Running` agent that cannot reach the center remains outside this floor and belongs to the second-channel design.

## Verification

The script parses under the `pwsh` PSParser; watchdog, restart, install, and uninstall paths were checked against schtasks semantics (`IgnoreNew`, `RestartCount`, task states) and a review pass caught the `-AlsoWatch` argv collapse, the missing stop-gate in `-Restart`, and the unchecked `/run` result before this shipped. Verified on the production Windows node: the recovered agent ran `-Install`, the watchdog task registered with `HarnessNodeGateway` in its watched set, and heartbeat, `execution_ready`, and the new log path all hold. Remaining host-verified item: whether `schtasks /end` kills the agent's `node.exe` grandchild — if it does not, a stopped task can leave an orphaned agent holding the lease until the watchdog starts a sibling.
