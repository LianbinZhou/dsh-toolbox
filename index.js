/**
 * Package root, host half.
 *
 * A bundle row loads this module, so the required export forms live here:
 * `Config`, `inject`, `name`, and `apply`. The implementation sits under
 * `src/host/` so tests can import the pure helpers directly.
 */

export {
  Config,
  apply,
  inject,
  name,
  makeGuard,
  readConfig,
  isOn,
  currentSwitches,
  PROBE_TOOL,
  GUARDED_TOOL,
  DENIAL,
} from './src/host/index.js'
