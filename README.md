# devkit

A lightweight, **local-only** dev cockpit for [Moqui](https://www.moqui.org/) / Maarg. It gives a
cold-start dev one screen that answers "what's running, how is it wired, and is my setup right?" —
and lets you start/stop the pieces. Zero dependencies, no build step, runs from anywhere.

```bash
npx github:hotwax/devkit
# then open http://127.0.0.1:7070
```

> Requires **Node 18+**. macOS-first (uses `lsof`, `screen`, Homebrew paths by default).

## What you get

A dashboard at `http://127.0.0.1:7070` with two tabs:

- **System architecture** — a live, color-coded map from the **Java 11 JVM → MySQL / Solr → Moqui →
  REST API → PWA apps**. Click any box for detail; running web nodes have an `↗` open link; click
  **Start / Stop / Restart** to control Moqui, MySQL, or a PWA dev server.
- **Running AccxUI apps** — detects localhost Vite/PWA servers, maps them back to app names and
  serving folders, and shows direct links so you do not have to remember which app owns which URL.
- **Details** —
  - **Preflight**: Java 11, ports (8080 / 3306 / 8983 / 9200), MySQL & Solr reachability, Moqui liveness.
  - **Effective config**: parsed from `runtime/log/MoquiActualConf.xml` (DB, search backends; secrets redacted).
  - **Components**: each `runtime/component/*` with its git **branch** (flags off-`main`) and
    **uncommitted-changes** state (modified / untracked).
  - **Expected components**: compares what you have against the `oms-suite` / `all` sets in
    `maarg-docker-config`'s `myaddons.xml`, and gives the exact `./gradlew getComponent` command for anything missing.
  - **Logs**: a byte-offset tail of the Moqui log (never full-reads it).
  - **Diagnose**: turns the observed signals into concrete next-actions (the Java-11-not-on-PATH trap,
    a port held by an orphaned GradleDaemon, MySQL down, missing components, …).

It's **read-mostly**: the only writes are the guarded Start / Stop / Restart actions, bound to
`127.0.0.1`. Stops scope-kill by PID (shown after the action) — never a blanket `pkill`.

## How it finds Moqui

`MOQUI_HOME` is auto-discovered, in order:

1. the **running** `java … -jar moqui.war` process (works no matter where you run devkit from);
2. `$MOQUI_HOME` / `devkit.config.json` (see below);
3. **walking up** from your current directory (so it self-locates when run from inside a checkout);
4. a configured run script's `cd` target.

So a Moqui-only dev can `cd` into their `moqui-framework` checkout and `npx github:hotwax/devkit`.

## Moqui-only vs. PWA workspace

If your current directory is an accxui-style PWA workspace (has `pnpm-workspace.yaml` or `apps/`),
devkit also discovers and manages the PWA dev servers. Otherwise it runs in **Moqui-only mode**: the
full Moqui stack is managed, and the PWA band is simply marked "not in this workspace."

## Configuration

Everything has sensible defaults. Override per-project with a `devkit.config.json` in the directory
you run devkit from:

```json
{
  "moquiRunScript": "/path/to/run-moqui-local.sh",
  "screens": { "moqui": "my-moqui", "solr": "my-solr" },
  "pwaApps": [{ "name": "order-manager", "port": 8106, "dir": "apps/order-manager" }]
}
```

…or with env vars (no file needed):

| var | purpose |
|---|---|
| `MOQUI_HOME` | explicit Moqui checkout path |
| `MOQUI_RUN_SCRIPT` | a script that `cd`s into the checkout and runs `./gradlew run` |
| `JAVA11_HOME` | Java 11 home (default: `/opt/homebrew/opt/openjdk@11`) |
| `MOQUI_CONSOLE_PORT` | console port (default `7070`) |
| `MOQUI_CONSOLE_NO_PWA=1` | force Moqui-only mode |

## License

Apache-2.0
