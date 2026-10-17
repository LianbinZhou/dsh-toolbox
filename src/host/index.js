/**
 * Host half of dsh-toolbox (S1).
 *
 * Two rules learned the hard way in the S1 review:
 *
 * 1. **`apply` must not return a plain object.** Cordis collects the return value
 *    as an effect and rejects anything that is not a function, null/undefined, a
 *    thenable or an iterable with `Invalid effect`. Reproduced on the real runtime:
 *    `root.plugin({ apply() { return { read: 1 } } })` + `await fiber` throws.
 *    So `apply` returns nothing here.
 * 2. **A settings read that fails must not switch a feature on.** Every read goes
 *    through `isOn`, which is fail-closed, and the guard denies its own tool when
 *    it cannot prove the switch is on.
 */

import { Config, isOn, readConfig } from './config.js'

export { Config, isOn, readConfig }
export const name = 'dsh-toolbox'
export const inject = ['tools']

export const PROBE_TOOL = 'toolbox_probe_ping'
export const GUARDED_TOOL = 'session_search'

/** The denial text: say who did it, say do not retry, offer a way forward. */
export const DENIAL =
  GUARDED_TOOL +
  ' is switched off by the user in dsh-toolbox settings. Do not retry it; ' +
  'answer from the current conversation, or ask the user to turn the switch back on.'

/**
 * The guard for a switch that only hides the tool.
 *
 * - It never throws: `tools.guard` runs inside the tool pipeline, so a throw here
 *   would become a tool error for EVERY tool.
 * - It checks the tool name before touching the config, so unrelated tools are
 *   never denied.
 * - It fails closed for its own tool: if the switch cannot be read, it denies.
 *
 * @param config - the row config (volatile ref or plain object)
 * @returns the guard predicate
 */
export function makeGuard(config) {
  return function toolboxGuard(exec) {
    let target
    try {
      target = exec && exec.name
    } catch (error) {
      return undefined
    }
    if (target !== GUARDED_TOOL) return undefined
    try {
      return isOn(config, 'sessionSearch') ? undefined : DENIAL
    } catch (error) {
      console.error('[dsh-toolbox] guard read failed; denying its own tool', error)
      return DENIAL
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

/**
 * Activate the host half.
 *
 * @param ctx - a Cordis context carrying the `tools` service
 * @param config - the row config
 * @returns nothing — a plain object here is an `Invalid effect` crash
 */
export function apply(ctx, config) {
  let offTool
  let toolsAvailable = !!(ctx && ctx.tools && typeof ctx.tools.register === 'function')

  const sync = (reason) => {
    if (!toolsAvailable) return
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

  // Deliberately no return value: see the header. The S1 review caught this.
}

/** Read-only helper for diagnostics and tests (not returned from `apply`). */
export function currentSwitches(config) {
  const values = readConfig(config)
  const out = {}
  for (const key of Object.keys(values)) out[key] = values[key]
  return out
}
