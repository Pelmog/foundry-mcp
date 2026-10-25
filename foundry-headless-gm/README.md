# Foundry headless GM

A supervised browser client for Foundry VTT v13.351. It joins the active world as
`Friend Computer`, exposes the bridge over a local Unix socket, and never launches
or switches worlds. The authoritative interface is
[`../docs/gm-client-contract.md`](../docs/gm-client-contract.md), sections 1, 3 and 5.

## Install on the Ubuntu 24.04 host

Prerequisites: Node 22+ at `/usr/bin/node`, npm/npx, systemd, the existing system
user/group `foundry-gm`, and `/etc/foundry-headless-gm.env` owned
`root:foundry-gm`, mode `0640`. The installer refuses a missing or incorrectly
owned/mode environment file. It never creates, prints, or sources credentials.

The environment file contains `FOUNDRY_URL`, `GM_USER_NAME`, `GM_PASSWORD`, and
optionally `FOUNDRY_GM_SOCKET`. Quote names containing spaces, for example
`GM_USER_NAME="Friend Computer"`. An explicitly empty password is supported.
Do not put passwords in this checkout or command-line arguments.

Copy this directory onto the host, then run there:

```sh
sudo bash ./install.sh
sudo systemctl status foundry-headless-gm.service
sudo journalctl -u foundry-headless-gm.service -n 100 --no-pager
sudo journalctl -u foundry-headless-gm.service -f
```

Installation is idempotent. It stops an existing worker, copies the application
to `/opt/foundry-headless-gm`, runs `npm ci --omit=dev`, installs the pinned
`chromium-headless-shell` and Ubuntu dependencies, fixes ownership of
`/var/lib/foundry-gm`, and installs, enables and restarts the unit. Foundry/PM2 is
not modified. An installation failure after stopping the worker leaves it stopped;
correct the failure and rerun the installer. OS dependency installation requires
working package repositories and can take several minutes. Do not run competing
apt operations. The installer is intended for the server, not macOS.

Playwright is pinned to **1.64.0**, published **2026-10-07**, at least two weeks
before implementation on 2026-10-25. `playwright-core` is its transitive dependency;
there are no other direct runtime dependencies. Browser binaries are installed in
`/opt/foundry-headless-gm/browsers` and must be reinstalled when updating Playwright.

## Status and debugging

The systemd process can be running while its GM state is `no-world`, `no-user`, or
`error`. Check the IPC status or JSON journal entries, not just `systemctl`.
This local status query needs no credential:

```sh
sudo /usr/bin/node --input-type=module -e '
import net from "node:net";
const socket = net.createConnection("/run/foundry-gm/gm.sock");
socket.on("connect", () => socket.write(JSON.stringify({id:"check",op:"status"}) + "\n"));
socket.on("data", data => { process.stdout.write(data); socket.end(); });
socket.on("error", error => { console.error(error.message); process.exitCode = 1; });
'
```

`--once` performs one status check and join, emits JSON lines with `event:"status"`
and, on success, `event:"info"`, then closes the browser. It does not bind the IPC
socket. A non-ready state exits non-zero. To run it with the existing protected
environment file and the **same sandbox policy** as the service, stop the service
first (a persistent Chromium profile cannot be shared):

```sh
sudo systemctl stop foundry-headless-gm.service
sudo systemd-run --unit=foundry-headless-gm-once --collect --wait --pipe \
  --property=User=foundry-gm --property=Group=foundry-gm \
  --property=EnvironmentFile=/etc/foundry-headless-gm.env \
  --property=WorkingDirectory=/opt/foundry-headless-gm \
  --property=StateDirectory=foundry-gm --property=StateDirectoryMode=0750 \
  --property=UMask=0007 --property=MemoryMax=1200M \
  --property=NoNewPrivileges=yes --property=ProtectSystem=strict \
  --property=ProtectHome=yes --property=PrivateTmp=yes \
  --property=ReadWritePaths=/var/lib/foundry-gm \
  --setenv=HOME=/var/lib/foundry-gm \
  --setenv=XDG_CACHE_HOME=/var/lib/foundry-gm/cache \
  --setenv=XDG_CONFIG_HOME=/var/lib/foundry-gm/config \
  --setenv=PLAYWRIGHT_BROWSERS_PATH=/opt/foundry-headless-gm/browsers \
  /usr/bin/node /opt/foundry-headless-gm/headless-gm.mjs --once
sudo systemctl start foundry-headless-gm.service
```

Always run the final start command after debugging, even if `--once` fails.
The persistent profile and browser cache may contain authenticated session data;
keep `/var/lib/foundry-gm` private to its owner/group. No screenshots, traces,
browser console logs or request bodies are recorded. JSON log values and status
errors redact the configured password, including Playwright error messages.

## Adding the user to another world

Using a human GM client in that world, enable bridge module version `2.0.0` and
create the user with the exact configured name, role **ASSISTANT (3)**, and the
password already configured for this worker. Do not use a full GAMEMASTER role:
the assistant role allows a human GAMEMASTER to remain preferred by
`game.users.activeGM`. The worker verifies the role, bridge version, world and user
identity before marking itself ready. It resolves the user ID from the join page
on every join; IDs do not need to match across worlds.

The worker reports `no-user` when the name is absent and retries with backoff. A
world change resets that backoff. It never creates users, enables modules, visits
setup, or starts worlds. Start or switch worlds through your normal human admin
workflow. It will notice within the next 15-second watchdog tick.

## Contract implementation

| Clause | Implementation |
| --- | --- |
| §1 dispatch | IPC and diagnostic info call `page.evaluate(({op,args}) => globalThis.foundryMcpBridge.dispatch(op,args), {op,args})`. No injected source strings. `info`, `exec`, `create`, `roll` are forwarded; document logic stays in the bridge. |
| §3 socket | `net.createServer`, default `/run/foundry-gm/gm.sock`, `FOUNDRY_GM_SOCKET` override, explicit chmod `0660`; unit supplies owner/group and runtime directory. Stale sockets are removed; live sockets, symlinks and ordinary files are refused. |
| §3 framing | NDJSON; multiple requests per connection; replies echo string IDs. Malformed JSON/envelopes produce `BAD_REQUEST`. Unrecoverable IDs are `null`. Lines have a 1 MiB safety limit. |
| §3 status/meta | Status bypasses the queue; reports state, generation, since and available identity/error fields. Success metadata always includes worldId, userId, userName, tabId, generation (unavailable IDs are null). |
| §3 execution | One global FIFO across all connections, one active dispatch, at most 50 waiting. The next waiting call gets `BUSY`. Non-ready calls get `NOT_READY`; world mismatch gets `WRONG_WORLD`; bridge exceptions become `EXEC_ERROR` with their message. |
| §3 timeout | Default 30000 ms; values above 120000 are clamped; non-positive/non-integer values are `BAD_REQUEST`. Deadline begins when accepted, including queue time. `TIMEOUT` never retries. Expired queued work is removed without executing. |
| §3 reload | Navigation, close, crash or Foundry socket disconnect invalidates active and queued work immediately with `NOT_READY`. Generation increments on each successful join; stuck-dispatch recovery advances it immediately and uses that generation for the replacement join. It is scoped to the worker process lifetime. Old work is never replayed. |
| §5 browser | One persistent context/browser, one game page; state under `/var/lib/foundry-gm/profile`. `addInitScript` sets `core.noCanvas` to the JSON text `true` before navigation. Headless-shell, disabled GPU, sandbox explicitly enabled. |
| §5 watchdog | Immediate check, then every 15 seconds, without overlapping checks. Status HTTP timeout 5 s. No active world closes the page. World/user/readiness/socket/tab changes trigger a rejoin. Failed attempts back off 15, 30, 60, 120, 240, then 300 seconds. |
| §5 join | `/join`, resolve `select[name="userid"] option` by exact name, fill `input[name="password"]`, click `button[name="join"]`, wait for `/game`, `game.ready` and bridge. Check identity with `info`. |
| §5 setup exclusion | Direct setup requests are blocked. Navigations continue normally (re-fetching them would drop Foundry's session cookie), and `join()` refuses any page that did not land on `/join`, so a redirect to `/setup` is never used. Cross-origin navigation is refused. |
| §5 supervision | System user, EnvironmentFile, runtime/state directories, `Restart=always`, 15 s restart delay, `MemoryMax=1200M`, JSON stdout, `--once`. SIGTERM/INT stops acceptance, fails pending work, closes browser and connections, removes socket. |

The service's socket override must point into a directory writable by `foundry-gm`.
The supplied unit allows `/run/foundry-gm` and `/var/lib/foundry-gm`; an override
elsewhere needs an appropriate systemd drop-in and directory ownership. The optional
`FOUNDRY_GM_STATE_DIR` has the same constraint. `/api/status` is fetched without
credentials or redirects. A Foundry route prefix in `FOUNDRY_URL` is preserved.

## Timeout and protocol caveats

Timeout means **unknown mutation outcome**, not cancellation. After replying
`TIMEOUT`, the worker allows the original dispatch a **15-second recovery grace
period**, configurable with `GM_STUCK_GRACE_MS` in the existing environment file
(integer milliseconds, 1–2147483647; restart the service after changing it). The
serial slot stays occupied during this grace period. Settlement cancels recovery.
If the dispatch still has not settled, the worker logs `dispatch-stuck`, enters
`joining`, advances generation, fails queued calls with `NOT_READY`, and closes the
page. It releases the slot even if the old evaluation promise never settles; the
watchdog joins a fresh page on its next check. The replacement join uses the
generation already reserved by recovery. Timeouts while waiting in the queue do
not initiate recovery, and no call is replayed. Inspect the world before
resubmitting a mutation: closing the page does not undo changes already applied.

The contract leaves three wire details unspecified: the ID for unparseable JSON
(`null` here), whether queue wait counts against a timeout (it does), and handling
of timeouts above the maximum (clamped here). It also cannot promise cancellation
of Foundry operations already sent by a page when that page is lost. These choices
should be stated in the shared contract by its owner; this implementation does
not modify it. There is no incompatibility found with the required dispatch API.

## Operational risks and troubleshooting

- **Memory:** 1200 MiB is a hard cgroup limit shared by Node and all Chromium
  processes. Canvas is disabled, but system/module hooks and loaded world data can
  still be large. Inspect `systemctl show foundry-headless-gm -p MemoryCurrent -p
  MemoryPeak -p MemoryMax` and the journal for OOM kills. Around 4.6 GB free before
  startup does not guarantee spare capacity alongside Docker workloads. A cgroup
  OOM stops the service and systemd restarts it; callers see broken connections
  and must treat their outcomes as unknown.
- **Ubuntu dependencies:** `npx playwright install --with-deps
  chromium-headless-shell` installs the libraries for this pinned release. Missing
  library or executable errors call for rerunning the installer, checking package
  repositories, and checking that the service's browser path matches installation.
  No browser or Ubuntu packages are installed by local tests.
- **Sandbox:** `chromiumSandbox:true` is deliberate; Playwright otherwise adds
  `--no-sandbox`. The unit leaves user namespaces and Chromium's seccomp machinery
  available. It uses `NoNewPrivileges`, so a setuid helper cannot elevate; Chromium
  must use the unprivileged user-namespace sandbox. Ubuntu 24.04 AppArmor policies
  or host namespace sysctls may still deny that sandbox for the downloaded binary.
  Check `journalctl -k` for AppArmor/userns denials and `sysctl
  kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns`.
  If denied, have the host administrator grant the installed headless-shell binary
  the required user-namespace permission with a narrowly scoped AppArmor policy.
  No global security policy is changed and there is no unsandboxed fallback.
  Actual host sandbox compatibility remains a deployment smoke-test requirement.
- **No GPU:** noCanvas and `--disable-gpu` remove the need for WebGL. Macros or
  module hooks requiring a rendered canvas can fail in this client. The
  `--disable-dev-shm-usage` flag moves shared-memory pressure to private temporary
  storage, which itself needs adequate space.
- **`no-user`:** create the assistant in the active world using the exact name.
  **`error` after join:** check password, assistant role, bridge enabled/version,
  and world module startup errors. Duplicate matching names are rejected.
- **`error` with status failures:** check Foundry/PM2 and its loopback port. No PM2
  ordering dependency is assumed; the worker waits/retries independently.
- **Navigation errors:** a direct base URL is required; navigation redirects are
  intentionally refused. In particular, returning to setup cannot be handled by
  this service. Check the active world and configured route prefix.
- **Profile locked:** stop another `--once`/service process using the same profile.
  Do not delete a live profile lock or run two worker instances against it.
- **Privacy and privilege:** socket access is GM script-execution authority. Keep
  membership of `foundry-gm` restricted. Do not enable Playwright tracing/debug
  request logging in production; it can capture form data.

## Local verification (no Foundry or browser required)

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
node --test
for file in headless-gm.mjs lib/*.mjs test/*.test.mjs; do node --check "$file"; done
bash -n install.sh
```

Tests use Unix sockets, fake page dispatchers, a fake browser context and fake
status responses. They cover required IPC behavior plus lifecycle/backoff,
setup-redirect blocking, sandbox launch configuration and password redaction.
They do not establish actual Foundry login, Chromium memory usage, Ubuntu library
availability or host sandbox compatibility. Run the supervised `--once` smoke
test on the host before relying on it for mutations.
