# T3 account failover

A local macOS companion that watches T3 Code for Codex and Antigravity usage
limits and asks T3 to continue the same thread on the next eligible account of
the same provider. It uses T3's guarded manual-continuation command and keeps
the selected model, model options, and thread permissions.

Checked against **T3 Code 0.1.9 through 0.1.11**, **Node 20.20.1**, and macOS's
`/usr/bin/python3` for advisory-lock inspection. This is an
unofficial companion using orchestration protocol 2. **There is no app-version
allowlist.** Any release that passes the required capability checks can connect.
It does not patch the app, edit T3's database, replace
Codex login files, or require OpenAI API keys.

## Setup

Keep T3 Code running and connect at least two accounts of the same provider.
Download the tool:

```sh
git clone https://github.com/Abd-echafi/T3-auto-provider-change-tool.git
cd T3-auto-provider-change-tool
npm ci
node bin/t3-failover.mjs init
node bin/t3-failover.mjs doctor
node bin/t3-failover.mjs watch --dry-run --once
node bin/t3-failover.mjs service-install
```

`init` discovers enabled Codex and Antigravity accounts and saves each rotation
order in `~/.config/t3-account-failover/config.json`. Existing configs discover
enabled Antigravity accounts automatically unless they set an explicit order.
`service-install` starts the watcher immediately and at macOS login. The Mac
must be awake. If T3 closes, the watcher keeps trying to reconnect. Keep this
project directory in place while the service is installed.

To run in a terminal instead:

```sh
node bin/t3-failover.mjs watch
```

By default it handles failures **after its first real start**, across top-level
Codex and Antigravity threads in this T3 environment.
To opt into recovering existing failures within the configured age window:

```sh
node bin/t3-failover.mjs watch --dry-run --once --include-existing
node bin/t3-failover.mjs watch --once --include-existing
```

Stop the service before running a second live watcher. A process lock prevents
two live watchers using the same state directory. Use one state directory per T3
environment; do not start multiple live watchers with different state directories.

## What happens at a usage limit

1. Every 2 seconds by default, the watcher checks for a failed thread whose root failure
   T3 classified as `usage_limit`.
2. It confirms the run is still the latest and has no active turn, queued turn,
   pending user request, or pending background task. It excludes idle compaction
   and subagent threads.
3. It walks the failed provider's account order, starting after the failed
   account and wrapping around. A target needs a working login, the same model
   and options, and fresh readings with headroom in the relevant quota windows.
4. For Codex, it checks the native conversation's OS writer lock. If it is held, it
   asks T3 to stop/release that conversation with the stopped run's ID as a guard.
   T3 refuses if a newer run has started and protects other working threads that
   share the provider process. The watcher waits for the lock to become free
   before sending anything to the destination account. It does not delete lock
   files or signal arbitrary Codex processes. When it cannot inspect ownership,
   it waits instead of switching.
5. It saves the recovery intent, then sends one T3 command containing both the
   target account and the ID of the stopped run. T3 rechecks the source run at
   dispatch. A changed run causes rejection instead of interrupting newer work.
6. If a response is lost, it retries the same command ID. T3's command replay
   handling prevents duplicate continuations. A definite server rejection stops
   retries for that run and records a notice in the log.
7. `continuation-requested` means T3 accepted the request. Only a subsequently
   observed running, waiting, or completed continuation produces
   `resume-confirmed`. A writer conflict or failed startup is logged separately;
   the task is not blindly replayed.

Quota is refreshed through T3 every five minutes. A freshly failed account is
quarantined until its reported reset, or five minutes if no reset is known, and
must subsequently have a newer healthy reading. Several threads failing on one
account share this quarantine. There are at most four automatic continuations per
thread per hour.

If every account in a provider's rotation is empty, the watcher waits for usable
quota. The original account can also resume after its reset. Failures older than
14 days are left for manual recovery by default.

## Scope and settings

Edit the generated config, then uninstall and reinstall the service to reload it.
Empty `threadIds` and `projectIds` watch all top-level Codex and Antigravity
threads. To limit recovery to a thread, set `threadIds` to its T3 thread ID.
Project and thread filters are combined when both are supplied.

| Setting | Default | Purpose |
| --- | --- | --- |
| `accountOrder` | discovered Codex accounts | Codex account IDs in rotation order |
| `antigravityAccountOrder` | discovered Antigravity accounts | Antigravity account IDs in rotation order |
| `threadIds` | `[]` | Optional thread allowlist |
| `projectIds` | `[]` | Optional project allowlist |
| `pollSeconds` | `2` | Failure detection interval. After requesting a Codex writer release, the watcher waits only 500 ms between checks for the first 10 seconds. |
| `refreshSeconds` | `300` | Quota refresh interval |
| `usageMaxAgeSeconds` | `600` | Maximum age of an eligible quota snapshot |
| `maxSwitchesPerHour` | `4` | Maximum automatic recovery attempts per thread per hour |
| `unknownResetCooldownSeconds` | `300` | Quarantine when a failure has no reset time |
| `writerReleaseWaitSeconds` | `300` | Time before reporting a prolonged writer wait; checking continues |
| `failureMaxAgeHours` | `336` | Maximum age of an automatically recovered failure |

`--config PATH` and `--state-dir PATH` select custom locations. `--dry-run` reads
live T3 state without sending recovery commands or updating recovery history.
`pythonCommand` optionally overrides the Python executable used for lock probes.

## Service and logs

```sh
node bin/t3-failover.mjs service-status
node bin/t3-failover.mjs service-uninstall
```

The LaunchAgent is `~/Library/LaunchAgents/local.t3-account-failover.plist`.
Logs and recovery state are in `~/.local/state/t3-account-failover/`:

- `service.log`: connection, waiting, and recovery events as JSON lines.
- `service-error.log`: startup failures.
- `state.json`: observed failures, account quarantines, and durable recovery IDs.
- `health.json`: process ID, last completed poll, connection state, and last poll error.

`service-status` shows the last successful check as well as the process state.
Recovery is reported separately as `healthy`, `degraded`, or `blocked`. An
incompatible recovery interface is explicitly `blocked`, even while the process runs.
A running process with an old or missing check is not proof that recovery is
working. When no replacement is eligible, each waiting event now includes the
specific reason for every account, such as exhausted quota, stale usage, or an
unsupported model option.

Uninstalling keeps the config and recovery history. Avoid deleting `state.json`
while the watcher is running. A stale `watch.lock` is reclaimed when its process
no longer exists. If a crash leaves `watch.lock.guard`, stop the service, verify
that no watcher process is running, remove that directory, then reinstall.

The tool mints a local T3 session scoped to orchestration read/operate, keeps its
token in memory, renews before expiry, and revokes on graceful shutdown. It
accepts only loopback server origins. Config and state files are written with
mode `0600`. A crash can leave a T3 session active until its 12-hour expiry.

## Limits

- Account rotation runs in the local T3 environment.
- Pending approvals, queued work, background tasks, manually snoozed threads,
  settled threads, and subagent threads are left for manual handling.
- Context continuity follows T3's account-switch behavior. Codex accounts sharing
  a continuation home can resume natively. T3 can hand off thread context between
  isolated profiles, including on Antigravity. T3 also controls background-task
  behavior during a switch.
- The watcher uses T3's existing server guard. It cannot add an atomic condition
  for every external observation, such as a user changing the model immediately
  before dispatch. It never intentionally changes a running thread.
- Compatible app updates work automatically. A breaking protocol, authentication,
  or data-format change can still require an adapter update.

## Automatic compatibility after updates

The app's release label is used only for logs and restart detection. On each
connection the watcher negotiates orchestration protocol 2 and validates the
provider catalog, account usage, thread state, model selections, and a sample
thread projection per provider when available. Live connections also verify
provider refresh and check that the dispatch and writer-release methods reject
nonexistent target IDs.

The watcher checks the server's identity on every poll and before sending a
recovery mutation. A changed process, start time, address, or version triggers
reconnection and fresh capability validation. Durable continuation IDs survive
that reconnect. A new patch, major, or nightly label needs no configuration edit
when its interfaces remain compatible.

Extra response fields and both list and legacy dictionary model options are
accepted. Missing methods or required fields identify the specific incompatible
operation in health/status output. When T3 omits the source message from a bounded projection, the watcher reads
only its ID, role, and idle-compaction marker from the local database in read-only
mode. Prompt text is never returned by this fallback. Unknown layouts or missing
metadata leave recovery blocked rather than guessing whether a run was maintenance.

The watcher keeps retrying so recovery can
resume after the interface becomes available again.

These checks establish availability and known response shapes. Invalid-target
probes do not prove every future server-side guard or locking semantic. There is
no guarantee for an arbitrary breaking API change, and the tool does not
automatically rewrite itself or remove ownership/continuation checks.

## “This conversation is open in another Codex client”

T3 can leave its previous account's Codex app-server holding the writer
after a manual account switch. The watcher works around this by requesting
release **before** changing the account and then checking the OS lock. Codex may
take about a minute to unload an unsubscribed thread, so this adds a visible
delay to recovery. An external Codex client can also hold the lock; close that
client to allow recovery to continue.

This companion does not patch T3's manual account picker. Existing conversations
already blocked by a manual switch are not automatically replayed, since their
failure is no longer a usage-limit failure. If the owner is an orphaned T3
app-server, fully quitting and reopening T3 after other work finishes releases
its managed clients. Lock ownership should be released by its client; deleting
an active lock file can permit competing writers.

Upstream report and proposed fix:
[T3 issue #30630](https://github.com/pingdotgg/t3code/issues/30630) and
[PR #30647](https://github.com/pingdotgg/t3code/pull/30647).

## Validation

```sh
npm test
npm run verify:live
npm run replay:incident
```

The automated suite exercises quota selection, stale snapshots, account
quarantine, reset recovery, permissions/options, races, duplicate suppression,
response loss, process locking, persistence, writer-release ordering, and real
OS lock probing. The optional live check reads the installed server, verifies
that it rejects a correctly formed continuation for a nonexistent thread, checks
that writer release rejects a nonexistent target, and
probes a live conversation's writer lock. It does not create a thread, consume
model quota, stop a valid run, or resume existing work. Live recovery after a real usage-limit failure has been observed on both
validated versions: Personal 3 to Personal 4 on T3 0.1.9, and Personal 4 to
Personal 2 on T3 0.1.10. The resumed run produced new tool activity. Capability
validation now happens automatically for future releases.

Transport-level tests simulate unseen patch, major, and nightly versions,
changes during an open connection, missing methods, malformed snapshots, and
unexpected probe acceptance. They assert that compatibility probes never target
an existing conversation and that writes wait for fresh validation after an update.

The live check also runs the actual account-selection policy against T3's model
option lists and verifies that a usable replacement account is selected with
the settings preserved. The regression suite uses T3's `[{ id, value }]` option
format. This catches the earlier bug that misread list indices as option names
and rejected every account as incompatible.

`replay:incident` reads the most recently recorded usage-limit incident and its
historical records through SQLite's read-only mode. It replays the release,
writer wait, selection, dispatch, and confirmation steps entirely in memory
using current account metadata. It never releases a real writer, sends a live
message, or changes the completed conversation.

Background and protocol reference:
[T3's account-failover discussion](https://github.com/pingdotgg/t3code/discussions/18949).
