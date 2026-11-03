# Hermes Status Telemetry (`status-telemetry`)

Responsive status bar telemetry chip and rich analytics popover for **Hermes Desktop**.

## Features

- **Consolidated & Window-Size Responsive Status Bar Chip** (`statusBar.right`):
  - **Always visible**: Session Cost (`$0.0123`)
  - **`>= 640px` (`sm`)**: Live / Rolling Token Throughput (`⚡ 48t/s`)
  - **`>= 768px` (`md`)**: Host RAM Usage (`🖥 14.7G`, expanding to `14.7G/32G (46%)` on ultra-wide `2xl`)
  - **`>= 1280px` (`xl`)**: Session Token Totals (`Σ 24.5k`)
  - **`>= 1536px` (`2xl`)**: Average API Request Latency (`◷ 1.2s`)
- **Automatic Status Bar Decluttering**:
  - Automatically hides duplicate core status bar items (`tokens-per-second`, `cache-hit-rate`, `running-timer`, `session-timer`, `system-resources`, `agents`, `cron`, `webhooks`, `terminal`) while keeping the visual `context-usage` progress bar.
- **Rich Click Popover**:
  - Current session cost (actual vs estimated), input/output/reasoning token breakdown, cache hit rate, API call & tool call counters, message & compaction count, live host RAM utilization bar, and Today / Last 7 Days profile spend rollups.

## Installation

```bash
hermes plugins install status-telemetry
hermes plugins enable status-telemetry
```

Then enable **Status Telemetry** in Hermes Desktop under **Settings → Plugins**.

## Disclosure (Catalog Rule 13)

- **Reads**: Reads local session metadata and token/cost counters from the active profile's `state.db` via the public `hermes_state.SessionDB` API (`get_session`, `search_sessions`) and host physical RAM stats via `psutil.virtual_memory()`. Never reads message contents, `.env`, or credentials.
- **Writes**: Updates `hermes.desktop.statusbarHidden.v2` in `window.localStorage` (and plugin-scoped `ctx.storage`) to hide duplicate built-in status bar items.
- **Network**: None (100% local read-only telemetry).

## License

MIT — Copyright (c) 2026 Shachar Iphraimov (`iphraimov@gmail.com`)
