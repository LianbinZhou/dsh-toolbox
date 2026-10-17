/**
 * Feature registry and contract validation.
 *
 * Contract:
 *
 *     mount(ctx, env) -> void | disposer | { dispose() }
 *
 * Both forms are honoured: whatever `mount` returns is passed to `scope.track`,
 * and `scope.track` de-duplicates by identity, so "returned a disposer AND
 * tracked it through env.track" runs it once.
 *
 * `reversible` is mandatory and means: "if this feature is switched off while it
 * is running, can it fully undo itself?" A feature that cannot (it wrote to the
 * page, patched a global, or persisted something) must declare false, and the
 * container then refuses to mount it before the real switch value is known.
 */

export function defineFeature(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('feature spec must be an object')
  const { id, configKey, title, mount, reversible } = spec
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('feature needs a string id')
  if (typeof configKey !== 'string' || configKey.length === 0) {
    throw new TypeError('feature ' + id + ' needs a configKey')
  }
  if (typeof mount !== 'function') throw new TypeError('feature ' + id + ' needs mount()')
  if (typeof reversible !== 'boolean') {
    throw new TypeError('feature ' + id + ' must declare reversible: true|false')
  }
  // `defaultOn` used to live here. It was never read (the container only honours
  // an explicit `true`), so it is gone rather than misleading.
  return Object.freeze({ id, configKey, title: title ?? id, mount, reversible })
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
