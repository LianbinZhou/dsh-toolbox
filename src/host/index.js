/**
 * Host half of dsh-toolbox (S1 skeleton).
 *
 * S1 only carries the two things the review demanded a red-light test for:
 *   - the real `Config` (root-object volatile) and a guard that never throws;
 *   - a conditional tool registration driven by `loader/volatile-update`.
 *
 * The archive feature arrives in S5; until then this half installs one probe
 * tool so the switch path stays observable end to end.
 */

import { Config, isOn, readConfig } from './config.js'

export { Config }
export const name = 'dsh-toolbox'
export const inject = ['tools']

export const PROBE_TOOL = 'toolbox_probe_ping'
export const GUARDED_TOOL = 'session_search'

/**
 * The guard for a switch that only hides the tool.
 *
 * Two hard rules, both from the review:
 *   1. It must never throw: `tools.guard` runs inside the tool pipeline, so a
 *      throw here becomes a tool error for EVERY tool.
 *   2. It must check the tool name first: returning a denial for an unguarded
 *      tool disables the whole tool system.
 *
 * @param config - the row config (volatile ref or plain object)
 * @returns the guard predicate
 */
export function makeGuard(config) {
  return function toolboxGuard(exec) {
    try {
      if (!exec || exec.name !== GUARDED_TOOL) return undefined
      if (isOn(config, 'sessionSearch')) return undefined
      return (
        GUARDED_TOOL +
        ' is switched off by the user. Do not retry it; ' +
        'answer from the current conversation or ask the user to re-enable the switch.'
      )
    } catch (error) {
      // A guard failure must never deny or crash unrelated tools.
      console.error('[dsh-toolbox] guard evaluation failed', error)
      return undefined
    }
  }
}

function registerProbe(ctx) {
  return ctx.tools.register({
    name: PROBE_TOOL,
    description:
      'Toolbox probe. Present only while the dsh-toolbox container is loaded; ' +
      'used to prove a switch can dispose a host tool live.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Anything; echoed back.' } },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: { type: 'string' }, at: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: 'toolbox_probe_ping ok=' + value.ok + ' at=' + value.at }],
    },
    async execute(args) {
      return { ok: true, note: (args && args.note) || '', at: new Date().toISOString() }
    },
  })
}

export function apply(ctx, config) {
  let offTool

  const sync = (reason) => {
    const want = isOn(config, 'sessionSearch') || isOn(config, 'archivePanel')
    if (want && offTool === undefined) {
      offTool = registerProbe(ctx)
      console.info('[dsh-toolbox] probe tool registered (' + reason + ')')
    } else if (!want && offTool !== undefined) {
      try {
        offTool()
      } catch (error) {
        console.error('[dsh-toolbox] disposing the probe tool failed', error)
      }
      offTool = undefined
      console.info('[dsh-toolbox] probe tool disposed (' + reason + ')')
    }
  }

  ctx.effect(() => {
    const offEvent = ctx.on('loader/volatile-update', () => sync('volatile-update'))
    sync('apply')
    return () => {
      try {
        offEvent()
      } catch (error) {
        console.error('[dsh-toolbox] removing the volatile listener failed', error)
      }
      if (offTool !== undefined) {
        try {
          offTool()
        } catch (error) {
          console.error('[dsh-toolbox] disposing the probe tool on teardown failed', error)
        }
        offTool = undefined
      }
    }
  }, 'dsh-toolbox: volatile switch drives the probe tool')

  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(makeGuard(config)), 'dsh-toolbox: guarded tool switch')
  }

  // Exposed for the host config test; harmless in production.
  return { read: () => readConfig(config) }
}
