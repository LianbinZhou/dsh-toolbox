/**
 * The five client features, S1 stubs.
 *
 * S1 only needs the shape: id, configKey, reversible, mount. The real bodies move
 * in from `dsh-plugins/*` during S2–S5. Each stub records one disposable effect
 * through `env.track`, so the container and leak tests can prove a toggle
 * really unwinds it.
 *
 * `reversible` answers "can this feature undo itself while it runs?".
 * `quote-reply` and `panel-menu` only own slots and listeners, so they are
 * reversible. The other three write to the page, to `Storage`, or to a restored
 * DOM, so they are not — the container must not mount them before the real
 * switch value is known.
 */

import { defineFeatures } from './registry.js'

/** One counter per mount, so the tests can assert mount counts. */
export function createFeatureProbe() {
  const mounts = new Map()
  return {
    bump(id) {
      mounts.set(id, (mounts.get(id) ?? 0) + 1)
      return mounts.get(id)
    },
    count(id) {
      return mounts.get(id) ?? 0
    },
  }
}

export function createFeatures(probe, host) {
  const track = (id, env) => {
    env.track(host.addListener(id, () => {}))
  }

  return defineFeatures([
    {
      id: 'quote-reply',
      configKey: 'quoteReply',
      title: '划词引用',
      reversible: true,
      mount(ctx, env) {
        probe.bump('quote-reply')
        track('quote-reply', env)
      },
    },
    {
      id: 'panel-menu',
      configKey: 'panelMenu',
      title: '面板收纳',
      reversible: true,
      mount(ctx, env) {
        probe.bump('panel-menu')
        track('panel-menu', env)
      },
    },
    {
      id: 'draft-saver',
      configKey: 'draftSaver',
      title: '草稿保险箱',
      reversible: false,
      mount(ctx, env) {
        probe.bump('draft-saver')
        track('draft-saver', env)
      },
    },
    {
      id: 'archive-panel',
      configKey: 'archivePanel',
      title: '历史归档',
      reversible: false,
      mount(ctx, env) {
        probe.bump('archive-panel')
        track('archive-panel', env)
      },
    },
    {
      id: 'plugin-zh',
      configKey: 'pluginZh',
      title: '插件汉化',
      reversible: false,
      mount(ctx, env) {
        probe.bump('plugin-zh')
        track('plugin-zh', env)
      },
    },
  ])
}
