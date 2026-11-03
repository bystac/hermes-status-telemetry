/**
 * Hermes Status Telemetry — Responsive statusbar readout & popover for Hermes Desktop.
 *
 * - Automatically declutters duplicate built-in statusbar items (`tokens-per-second`,
 *   `cache-hit-rate`, `running-timer`, `session-timer`, `system-resources`,
 *   `agents`, `cron`, `webhooks`, `terminal`) so the bar stays compact while
 *   keeping the visual `context-usage` progress bar.
 * - Adds a responsive telemetry chip in `statusBar.right` that adapts to window width:
 *     • Always visible: Session Cost ($0.0123 or $0.00)
 *     • >= 640px (sm): Live / Rolling Tokens per Second (tok/s)
 *     • >= 768px (md): Host RAM Usage (compact 14.7G, full 14.7G/32G on 2xl)
 *     • >= 1280px (xl): Session Token Totals (Σ 24.5k)
 *     • >= 1536px (2xl): Average API Latency (◷ 1.2s)
 * - Uses 100% public SDK surfaces (`ctx.rest`, `host.request`, `host.state`, `host.onEvent`).
 */

import {
  Button,
  cn,
  compactNumber,
  haptic,
  host,
  icons,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  STATUSBAR_AREAS,
  Tip,
  usePluginI18n,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

const ID = 'status-telemetry'
const STATUSBAR_HIDDEN_KEY = 'hermes.desktop.statusbarHidden.v2'

const DUPLICATE_CORE_ITEMS = [
  'tokens-per-second',
  'cache-hit-rate',
  'running-timer',
  'session-timer',
  'system-resources',
  'agents',
  'cron',
  'webhooks',
  'terminal'
]

function getHiddenStatusbarIds() {
  try {
    const raw = window.localStorage.getItem(STATUSBAR_HIDDEN_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : null
  } catch {
    return null
  }
}

function declutterStatusbarItems(ctx, force = false) {
  try {
    const alreadyCleaned = ctx.storage.get('decluttered.v3', false)
    if (alreadyCleaned && !force) return

    const current = new Set(getHiddenStatusbarIds() ?? DUPLICATE_CORE_ITEMS)
    for (const id of DUPLICATE_CORE_ITEMS) {
      current.add(id)
    }
    current.delete('context-usage')

    const nextJson = JSON.stringify([...current])
    window.localStorage.setItem(STATUSBAR_HIDDEN_KEY, nextJson)
    window.dispatchEvent(new StorageEvent('storage', { key: STATUSBAR_HIDDEN_KEY, newValue: nextJson }))
    ctx.storage.set('decluttered.v3', true)
  } catch {
    // ignore storage errors
  }
}

function formatUsd(val) {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    return '$0.00'
  }
  if (val < 0.01) {
    return `$${val.toFixed(4)}`
  }
  if (val < 1) {
    return `$${val.toFixed(3)}`
  }
  return `$${val.toFixed(2)}`
}

function fmtGb(bytes, decimals = 1) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
  return `${(bytes / (1024 ** 3)).toFixed(decimals)}G`
}

function StatRow({ label, value, subvalue, accent = false }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-2 text-[0.72rem] leading-tight py-0.5',
    children: [
      jsx('span', {
        className: 'text-(--ui-text-tertiary) truncate',
        children: label
      }),
      jsxs('span', {
        className: cn(
          'shrink-0 font-mono tabular-nums',
          accent ? 'text-(--ui-accent) font-medium' : 'text-foreground'
        ),
        children: [
          value,
          subvalue &&
            jsx('span', {
              className: 'ml-1 text-[0.65rem] text-(--ui-text-quaternary)',
              children: subvalue
            })
        ]
      })
    ]
  })
}

function TelemetryChip({ ctx }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const focusedSessionId = useValue(host.state.focusedSessionId)
  const activeSessionId = useValue(host.state.activeSessionId)
  const focusedStoredId = useValue(host.state.focusedStoredSessionId)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const focusedUsage = useValue(host.state.focusedUsage)
  const busy = useValue(host.state.busy)
  const model = useValue(host.state.model)
  const gatewayState = useValue(host.state.gateway)

  const runtimeSid = focusedSessionId || activeSessionId

  useEffect(() => {
    const offComplete = host.onEvent('message.complete', () => {
      void queryClient.invalidateQueries({ queryKey: [ID] })
    })
    const offUsage = host.onEvent('session.usage', () => {
      void queryClient.invalidateQueries({ queryKey: [ID, 'live-usage'] })
    })
    const offInfo = host.onEvent('session.info', () => {
      void queryClient.invalidateQueries({ queryKey: [ID, 'live-usage'] })
    })
    return () => {
      offComplete()
      offUsage()
      offInfo()
    }
  }, [queryClient])

  // 1) Live session usage via gateway RPC (gives avg_tps, avg_latency_s, cache_hit_pct, reasoning, etc.)
  const liveUsageQuery = useQuery({
    queryKey: [ID, 'live-usage', runtimeSid, busy],
    queryFn: async () => {
      if (!runtimeSid) return null
      try {
        return await host.request('session.usage', { session_id: runtimeSid })
      } catch {
        return null
      }
    },
    enabled: Boolean(runtimeSid) && gatewayState === 'open',
    refetchInterval: busy ? 2000 : 10000,
    staleTime: 1500
  })

  // 2) Session cost & 7-day profile rollup via plugin backend (`ctx.rest('/telemetry')`)
  const telemetryQuery = useQuery({
    queryKey: [ID, 'telemetry', focusedProfile, focusedStoredId, busy],
    queryFn: async () => {
      const qs = focusedStoredId ? `?session_id=${encodeURIComponent(focusedStoredId)}&days=7` : '?days=7'
      try {
        return await ctx.rest(`/telemetry${qs}`)
      } catch {
        return null
      }
    },
    enabled: gatewayState === 'open',
    refetchInterval: busy ? 4000 : 15000,
    staleTime: 2500
  })

  // 3) Host RAM probe via plugin backend (`ctx.rest('/hardware')`)
  const hardwareQuery = useQuery({
    queryKey: [ID, 'hardware'],
    queryFn: async () => {
      try {
        return await ctx.rest('/hardware')
      } catch {
        return null
      }
    },
    enabled: gatewayState === 'open',
    refetchInterval: open ? 4000 : 10000,
    staleTime: 3500
  })

  const usage = { ...(liveUsageQuery.data || {}), ...(focusedUsage || {}) }
  const row = telemetryQuery.data?.session
  const hw = hardwareQuery.data

  const sessionCostRaw =
    typeof usage.cost_usd === 'number' && usage.cost_usd > 0
      ? usage.cost_usd
      : (row?.actual_cost_usd || row?.estimated_cost_usd || 0)

  const tps = typeof usage.avg_tps === 'number' && usage.avg_tps > 0 ? usage.avg_tps : null
  const latency = typeof usage.avg_latency_s === 'number' && usage.avg_latency_s > 0 ? usage.avg_latency_s : null
  const cacheHit = typeof usage.cache_hit_pct === 'number' ? usage.cache_hit_pct : null

  const inputTok = usage.input || row?.input_tokens || 0
  const outputTok = usage.output || row?.output_tokens || 0
  const reasoningTok = usage.reasoning || row?.reasoning_tokens || 0
  const totalTok = usage.total || inputTok + outputTok
  const apiCalls = usage.calls || row?.api_call_count || 0
  const toolCalls = row?.tool_call_count || 0
  const msgCount = row?.message_count || 0
  const compressions = usage.compressions || 0

  const ramTotalBytes = hw?.ram_total_bytes || 0
  const ramAvailBytes = hw?.ram_available_bytes || 0
  const ramUsedBytes = ramTotalBytes > 0 ? Math.max(0, ramTotalBytes - ramAvailBytes) : 0
  const ramPct = ramTotalBytes > 0 ? Math.round((ramUsedBytes / ramTotalBytes) * 100) : null
  const ramBarCompact = ramTotalBytes > 0 ? `${fmtGb(ramUsedBytes, 1)}` : null
  const ramBarFull = ramTotalBytes > 0 ? `${fmtGb(ramUsedBytes, 1)}/${fmtGb(ramTotalBytes, 0)} (${ramPct}%)` : null

  const dailyList = telemetryQuery.data?.daily || []
  const todayEntry = dailyList.length > 0 ? dailyList[dailyList.length - 1] : null
  const todayCost = todayEntry ? (todayEntry.actual_cost || todayEntry.estimated_cost || 0) : null
  const weekTotals = telemetryQuery.data?.totals
  const weekCost = weekTotals ? (weekTotals.total_actual_cost || weekTotals.total_estimated_cost || 0) : null

  const costLabel = formatUsd(sessionCostRaw)
  const tpsLabel = tps !== null ? `${Math.round(tps)} tok/s` : null
  const tpsCompact = tps !== null ? `${Math.round(tps)}t/s` : null
  const latencyLabel = latency !== null ? `${latency.toFixed(1)}s` : null
  const totalTokLabel = totalTok > 0 ? `Σ${compactNumber(totalTok)}` : null

  const handleDeclutterBar = useCallback(() => {
    haptic('tap')
    declutterStatusbarItems(ctx, true)
    host.notify({
      kind: 'info',
      message: 'Removed duplicate core statusbar items.'
    })
  }, [ctx])

  return jsxs(Popover, {
    open,
    onOpenChange: nextOpen => {
      if (nextOpen) haptic('tap')
      setOpen(nextOpen)
    },
    children: [
      jsx(TooltipWrapper, {
        label: t('chipTooltip'),
        children: jsx(PopoverTrigger, {
          asChild: true,
          children: jsxs('button', {
            type: 'button',
            className: cn(
              'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-mono tabular-nums transition-colors shrink-0',
              'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
              busy && 'text-(--ui-accent)'
            ),
            children: [
              // 1. Cost segment (Always visible)
              jsx('span', {
                className: 'inline-flex items-center text-foreground font-medium',
                children: costLabel
              }),

              // 2. TPS segment (Visible >= sm, only when tps > 0 or busy)
              (tpsCompact || busy) &&
                jsxs('span', {
                  className: 'hidden sm:inline-flex items-center gap-0.5',
                  children: [
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
                    jsx(icons.Zap, { className: 'size-2.5 text-(--ui-accent)' }),
                    jsx('span', { children: tpsCompact || '…' })
                  ]
                }),

              // 3. Host RAM segment (Visible >= md, compact 14.7G, full on >= 2xl)
              ramBarCompact &&
                jsxs('span', {
                  className: 'hidden md:inline-flex items-center gap-0.5 text-(--ui-text-secondary)',
                  children: [
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
                    jsx(icons.Cpu, { className: 'size-2.5' }),
                    jsx('span', { className: '2xl:hidden', children: ramBarCompact }),
                    jsx('span', { className: 'hidden 2xl:inline', children: ramBarFull })
                  ]
                }),

              // 4. Total tokens Σ segment (Visible >= xl)
              totalTokLabel &&
                jsxs('span', {
                  className: 'hidden xl:inline-flex items-center gap-0.5',
                  children: [
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
                    jsx('span', { children: totalTokLabel })
                  ]
                }),

              // 5. Latency segment (Visible >= 2xl)
              latencyLabel &&
                jsxs('span', {
                  className: 'hidden 2xl:inline-flex items-center gap-0.5',
                  children: [
                    jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
                    jsx('span', { children: `◷${latencyLabel}` })
                  ]
                })
            ]
          })
        })
      }),

      jsx(PopoverContent, {
        side: 'top',
        align: 'end',
        sideOffset: 8,
        className: 'w-80 p-3 text-xs border-(--ui-stroke-secondary)',
        children: jsxs('div', {
          className: 'flex flex-col gap-2.5',
          children: [
            jsxs('div', {
              className: 'flex items-center justify-between gap-2',
              children: [
                jsxs('div', {
                  className: 'flex items-center gap-1.5 font-medium text-foreground',
                  children: [
                    jsx(icons.Activity, { className: 'size-3.5 text-(--ui-accent)' }),
                    jsx('span', { children: 'Session Telemetry & Host RAM' })
                  ]
                }),
                jsx('span', {
                  className: 'font-mono text-[0.65rem] text-(--ui-text-quaternary) truncate max-w-[130px]',
                  children: focusedProfile || 'default'
                })
              ]
            }),

            jsx(Separator, {}),

            jsxs('div', {
              className: 'grid grid-cols-3 gap-1.5',
              children: [
                jsxs('div', {
                  className: 'rounded border border-(--ui-stroke-secondary) p-1.5 flex flex-col',
                  children: [
                    jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: 'Session Cost' }),
                    jsx('span', {
                      className: 'font-mono text-sm font-semibold text-(--ui-accent) tabular-nums',
                      children: costLabel
                    }),
                    jsx('span', {
                      className: 'text-[0.6rem] text-(--ui-text-tertiary) truncate',
                      children: row?.cost_status === 'actual' ? 'Actual billed' : 'Estimated'
                    })
                  ]
                }),
                jsxs('div', {
                  className: 'rounded border border-(--ui-stroke-secondary) p-1.5 flex flex-col',
                  children: [
                    jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: 'Throughput' }),
                    jsx('span', {
                      className: 'font-mono text-sm font-semibold text-foreground tabular-nums',
                      children: tpsLabel || '—'
                    }),
                    jsx('span', {
                      className: 'text-[0.6rem] text-(--ui-text-tertiary) truncate',
                      children: latencyLabel ? `Avg ${latencyLabel}/req` : 'Rolling avg'
                    })
                  ]
                }),
                jsxs('div', {
                  className: 'rounded border border-(--ui-stroke-secondary) p-1.5 flex flex-col',
                  children: [
                    jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: 'Total Tokens' }),
                    jsx('span', {
                      className: 'font-mono text-sm font-semibold text-foreground tabular-nums',
                      children: compactNumber(totalTok)
                    }),
                    jsx('span', {
                      className: 'text-[0.6rem] text-(--ui-text-tertiary) truncate',
                      children: `${apiCalls} API · ${toolCalls} tools`
                    })
                  ]
                })
              ]
            }),

            ramTotalBytes > 0 &&
              jsxs('div', {
                className: 'rounded border border-(--ui-stroke-secondary) p-2 flex flex-col gap-1',
                children: [
                  jsxs('div', {
                    className: 'flex items-center justify-between text-[0.68rem]',
                    children: [
                      jsxs('span', {
                        className: 'flex items-center gap-1 font-medium text-foreground',
                        children: [
                          jsx(icons.Cpu, { className: 'size-3 text-(--ui-accent)' }),
                          jsx('span', { children: 'Host Memory (RAM)' })
                        ]
                      }),
                      jsx('span', {
                        className: 'font-mono tabular-nums text-foreground',
                        children: `${fmtGb(ramUsedBytes, 1)} / ${fmtGb(ramTotalBytes, 1)} (${ramPct}%)`
                      })
                    ]
                  }),
                  jsx('div', {
                    className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-stroke-secondary)',
                    children: jsx('div', {
                      className: cn(
                        'h-full rounded-full transition-all',
                        ramPct >= 85 ? 'bg-red-500' : ramPct >= 70 ? 'bg-amber-500' : 'bg-(--ui-accent)'
                      ),
                      style: { width: `${Math.min(100, Math.max(2, ramPct || 0))}%` }
                    })
                  }),
                  jsx('div', {
                    className: 'flex items-center justify-between text-[0.6rem] text-(--ui-text-tertiary)',
                    children: [
                      jsx('span', { children: `Free: ${fmtGb(ramAvailBytes, 1)}` }),
                      jsx('span', { children: 'Live via psutil' })
                    ]
                  })
                ]
              }),

            jsxs('div', {
              className: 'flex flex-col gap-0.5',
              children: [
                jsx('div', {
                  className: 'text-[0.65rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary) mb-0.5',
                  children: 'Current Session Breakdown'
                }),
                jsx(StatRow, {
                  label: 'Active Model',
                  value: (model || row?.model || '—').split('/').pop()
                }),
                jsx(StatRow, {
                  label: 'Input / Output Tokens',
                  value: `${compactNumber(inputTok)} in · ${compactNumber(outputTok)} out`
                }),
                reasoningTok > 0 &&
                  jsx(StatRow, {
                    label: 'Reasoning Tokens',
                    value: compactNumber(reasoningTok)
                  }),
                jsx(StatRow, {
                  label: 'Cache Hit Rate',
                  value: cacheHit !== null ? `${Math.round(cacheHit)}%` : '—'
                }),
                jsx(StatRow, {
                  label: 'API Calls / Tool Calls',
                  value: `${apiCalls} API · ${toolCalls} tools`
                }),
                jsx(StatRow, {
                  label: 'Messages / Compactions',
                  value: `${msgCount} msgs · ${compressions} cmp`
                })
              ]
            }),

            (todayCost !== null || weekCost !== null) &&
              jsxs(Fragment, {
                children: [
                  jsx(Separator, {}),
                  jsxs('div', {
                    className: 'flex flex-col gap-0.5',
                    children: [
                      jsx('div', {
                        className: 'text-[0.65rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary) mb-0.5',
                        children: 'Profile Spend Rollup'
                      }),
                      todayEntry &&
                        jsx(StatRow, {
                          label: `Today (${todayEntry.day})`,
                          value: formatUsd(todayCost),
                          subvalue: `${todayEntry.sessions || 0} sess · ${compactNumber((todayEntry.input_tokens || 0) + (todayEntry.output_tokens || 0))} tok`,
                          accent: true
                        }),
                      weekTotals &&
                        jsx(StatRow, {
                          label: 'Last 7 Days',
                          value: formatUsd(weekCost),
                          subvalue: `${weekTotals.total_sessions || 0} sess · ${compactNumber((weekTotals.total_input || 0) + (weekTotals.total_output || 0))} tok`
                        })
                    ]
                  })
                ]
              }),

            jsx(Separator, {}),

            jsxs('div', {
              className: 'flex items-center justify-between gap-2 pt-0.5',
              children: [
                jsx(Button, {
                  size: 'sm',
                  variant: 'outline',
                  className: 'h-6 text-[0.68rem] px-2',
                  onClick: handleDeclutterBar,
                  children: 'Hide Duplicate Bar Items'
                }),
                jsx(Button, {
                  size: 'sm',
                  variant: 'ghost',
                  className: 'h-6 text-[0.68rem] px-2',
                  onClick: () => {
                    setOpen(false)
                    host.navigate('/command-center?section=analytics')
                  },
                  children: 'Full Analytics →'
                })
              ]
            })
          ]
        })
      })
    ]
  })
}

function TooltipWrapper({ label, children }) {
  return jsx(Tip, { label, children })
}

export default {
  id: ID,
  name: 'Status Telemetry',
  description: 'Displays session cost ($), tok/s, API latency, token totals (Σ), 7-day spend, and host RAM in the status bar.',
  defaultEnabled: true,
  register(ctx) {
    declutterStatusbarItems(ctx, false)

    ctx.i18n.register({
      en: {
        chipTooltip: 'Session Cost · Throughput (tok/s) · Host RAM · Tokens — click for full breakdown'
      }
    })

    ctx.register({
      id: 'telemetry-chip',
      area: STATUSBAR_AREAS.right,
      order: 20,
      render: () => jsx(TelemetryChip, { ctx })
    })

    ctx.register({
      id: 'declutter-statusbar-items',
      area: PALETTE_AREA,
      data: {
        label: 'Status Bar: Hide Duplicate Telemetry Items (Compact Mode)',
        codicon: 'dashboard',
        run: () => {
          declutterStatusbarItems(ctx, true)
          host.notify({
            kind: 'info',
            message: 'Status bar decluttered.'
          })
        }
      }
    })
  }
}
