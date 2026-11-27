# S.T.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/st-logo-dark.svg" />
  <img src="brand/st-logo-light.svg" alt="S.T. Seam logo" width="80" height="80" />
</picture>

[Logo assets and usage](brand/README.md)

  S.T. provides a voice assistant, touchscreen and system dashboard for a Linux host.

  | Component | Documentation |
  | --- | --- |
  | Assistant, voice clients and planner | [STapp](stapp/README.md) |
  | Resource monitoring and dashboard | [SM Manager](sm-manager/README.md) |

  Run each component's build and installation commands from its directory.

Use the shared `st` command after installing STapp:

```sh
st agents list                  # Agent sessions
st tasks list                   # Open planner tasks
st calendar list                # Calendar events
st notes list                   # Local faceplate notes
st planner projects list        # Task projects
st requests --status waiting    # Assistant requests
st worktrees --running          # Monitored worktrees
st status                       # System monitor
st night on                     # Screen off; services keep running
st night off                    # Screen on
st photos status
st photos search "mountains" --semantic
st ask "What is on my calendar?"
st status REQUEST_ID            # Assistant request status
```

`st monitor ...` exposes the existing monitor commands. The `sm` and `stctl`
commands remain available for existing scripts and paired devices.


The [CLI guide](stapp/docs/cli.md) covers command options, editing, recurrence and safe retries.

## License

Original S.T. code is licensed under the [MIT License](LICENSE).
Vendored code and third-party assets retain their respective licenses and notices.
