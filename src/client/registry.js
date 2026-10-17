/**
 * Feature registry and contract validation.
 *
 * Contract (now consistent with the container, review 3.5):
 *
 *     mount(ctx, env) -> void | disposer | { dispose() }
 *
 * Both forms are honoured: whatever `mount` returns is passed to `scope.track`.
 * A feature that returns a disposer AND uses `env.track` is therefore safe —
 * no effect is ever silently unowned.
 *
 * `reversible` is mandatory and means: "if this feature is switched off while
 * it is running, can it fully undo itself?" A feature that cannot (it wrote to
 * the page, patched a global, or persisted something) must declare false, and
 * the container then refuses to mount it before the real switch value is known.
 */

export function defineFeature(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('feature spec must be an object')
  const { id, configKey, title, mount, reversible, defaultOn } = spec
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('feature needs a string id')
  if (typeof configKey !== 'string' || configKey.length === 0) {
    throw new TypeError('feature ' + id + ' needs a configKey')
  }
  if (typeof mount !== 'function') throw new TypeError('feature ' + id + ' needs mount()')
  if (typeof reversible !== 'boolean') {
    throw new TypeError('feature ' + id + ' must declare reversible: true|false')
  }
  if (defaultOn !== undefined && typeof defaultOn !== 'boolean') {
    throw new TypeError('feature ' + id + ' has a non-boolean defaultOn')
  }
  return Object.freeze({ id, configKey, title: title ?? id, mount, reversible, defaultOn: defaultOn ?? false })
}

/** Collect a feature list, rejecting duplicate ids and duplicate config keys. */
export function defineFeatures(list) {
  const ids = new Set()
  const keys = new Set()
  return list.map((spec) => {
    const feature = defineFeature(spec)
    if (ids.has(feature.id)) throw new Error('duplicate feature id: ' + feature.id)
    if (keys.has(feature.configKey)) throw new Error('duplicate configKey: ' + feature.configKey)
    ids.add(feature.id)
    keys.add(feature.configKey)
    return feature
  })
}
