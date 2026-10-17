/**
 * Package root, host half.
 *
 * A bundle row loads this module, so the required export forms live here:
 * `Config`, `inject`, `name`, and `apply`. The implementation sits under
 * `src/host/` so the S1 tests can import the pure helpers directly.
 */

export { Config, apply, inject, name, makeGuard, readConfig, isOn, PROBE_TOOL, GUARDED_TOOL } from './src/host/index.js'
