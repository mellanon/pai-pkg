## CLI Reference

### Package Management

```bash
arc install <name-or-url>     # Install from registry or direct git URL
arc install <name> --bin-dir <path> # Override where command shims are installed
arc install <name> --stack <name>      # Target a config-split cortex stack (~/.config/metafactory/cortex/<name>)
arc install <name> --config-dir <path> # Target a config-split cortex stack by its config dir / pointer file
arc list                      # List installed packages
arc list --json               # Output as JSON
arc list --type <type>        # Filter by artifact type (skill, tool, agent, prompt, component, pipeline)
arc info <name>               # Show details, capabilities, release notes
arc audit                     # Audit capability surface (summary + cross-tier warnings)
arc audit --verbose           # Full pairwise capability combination list
arc verify <name>             # Verify manifest integrity
arc validate [path]           # Strictly validate an arc/v1 manifest (default: cwd) — exit 1 with one line per violation
```

### Lifecycle

```bash
arc disable <name>            # Disable (preserves repo clone)
arc enable <name>             # Re-enable a disabled package
arc remove <name>             # Completely uninstall (cascades to exclusively-owned depends_on.packages)
arc remove <name> --keep-deps # Uninstall only the named package; leave its depends_on.packages installed
```

`arc remove` cascades removal to the package's `depends_on.packages` (arc#348),
but only those not still required by another installed package (shared-dependency
refcounting). A dependency another active package still declares is kept and
reported. Pass `--keep-deps` to opt out and remove only the named package.

### Upgrades

```bash
arc upgrade --check           # Check for available upgrades
arc upgrade                   # Upgrade all packages
arc upgrade <name>            # Upgrade a specific package
arc self-upgrade              # Update arc itself (git pull + frozen bun install)
arc self-update               # Alias for self-upgrade
arc upgrade-core <version>    # Upgrade PAI core version (symlink management)
```

### Discovery

```bash
arc search [keyword]          # Search all configured sources (omit keyword to list all)
```

### Source Management

```bash
arc source list               # Show configured registry sources
arc source add <name> <url>   # Add a source (--tier official|community|custom)
arc source update             # Refresh indexes from all sources (like apt update)
arc source remove <name>      # Remove a source
```

### Local Configuration

```bash
arc config get bin-dir        # Show where command shims are installed
arc config set bin-dir ~/.local/bin
arc doctor path               # Check whether the shim directory is on PATH
```

### Scaffolding

```bash
arc init <name>               # Scaffold new skill repo (default)
arc init <name> --type tool   # Scaffold tool
arc init <name> --type agent  # Scaffold agent
arc init <name> --type prompt # Scaffold prompt
arc init <name> --type pipeline # Scaffold pipeline
```

### NATS / NSC

```bash
arc nats init-operator --name <op>      # Create the principal's nsc operator if absent (idempotent)
arc nats init-operator --name <op> --force # Recreate an existing operator (DESTRUCTIVE: regenerates identity key)
arc nats add-account <NAME>             # Create an account under the current operator if absent (idempotent)
arc nats add-bot <name>                 # Issue a per-bot NATS user with credentials
arc nats reissue-bot <name>             # Revoke and re-issue a bot user's credentials
arc nats remove-bot <name>              # Revoke a bot user (optionally delete creds)
arc nats list-bots                      # List bot users under the current account
arc nats setup-operator <account> --bots <list> # Provision multiple bots in one shot
arc nats add-federation-export --from-account <A> --to-account <B> # Wire federated.> cross-account export/import
```

All `arc nats` subcommands accept `--json` for a stable machine-readable envelope.
`init-operator` + `add-account` emit schema `arc.nats.operator.v1`; user-management
commands emit `arc.nats.v1`; `add-federation-export` emits `arc.nats.federation.v1`.
See [`docs/integrations/cortex-creds.md`](../integrations/cortex-creds.md) for the contract.
