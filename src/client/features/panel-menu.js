/**
 * Feature: panel-menu (S4-a, migrated from dsh-plugins/dsh-panel-menu).
 *
 * What it does: the sidebar grows five panel rows over time; this feature hides
 * them behind one "all panels" trigger in the sidebar footer, and lists them in a
 * popover in the frame overlay. The intent is to give the conversation list the
 * vertical space back.
 *
 * Everything below the header is the original code, moved verbatim: the module
 * level helpers, the menu store, and the whole old `apply` body (now `applyBody`).
 * Only two things changed:
 *
 *   1. `ctx.effect` is redirected through `env.track` (see `mount`), so switching
 *      the feature off disposes both slots. The stylesheet that hides the native
 *      rows is rendered BY the trigger component as a React <style> node, so it
 *      disappears with the component: dispose brings the hidden rows straight
 *      back. That is the hard acceptance criterion for this feature.
 *   2. `layout` is resolved through the inject-free `ctx.get("layout")` path when
 *      it is not declared, because the toolbox client only injects slots+locale.
 *
 * React arrives through the runtime bridge (late-bound), never as an import.
 */

import { createDshAdapter } from '../dsh-adapter.js'
import { h, useEffect, useState, fragment } from '../runtime.js';


    const NS = 'dsh-panel-menu';
    const TRIGGER_SLOT = 'sidebar.footer.action';
    const OVERLAY_SLOT = 'shell.overlay';
    const TRIGGER_ID = 'panel-menu.trigger';
    const MENU_ID = 'panel-menu.menu';
    /** The slot whose entries are the sidebar's own panel rows. */
    const PANEL_SLOT = 'sidebar.panellist';

    /**
     * The sidebar's panel nav, matched by its CSS-module local name. The
     * shipped class is `<hash>_panelList`.
     */
    const NAV_SELECTOR = '[class*="panelList"]';

    /**
     * Rows a plugin injects into the sidebar as plain DOM instead of a slot
     * entry. The ledger above cannot see them and `selectPanel` cannot open
     * them, so each is matched by class token, hidden by the same stylesheet,
     * and activated through its own click handler.
     *
     * `[class~="..."]` matches the exact token, so the row's inner spans
     * (`dsham-entryIcon`, `dsham-entryLabel`) are deliberately not matched.
     * Add a line here for another such row; `labelKey` is only a fallback for
     * rows that carry no `aria-label` of their own.
     */
    const PROXY_ENTRIES = [
      {
        selector: '[class~="dsham-entry"]',
        labelKey: 'archive',
        order: 20,
        activeAttr: 'data-active',
      },
    ];

    /**
     * Rename a ledger entry in this menu, keyed by its panel id and valued by a
     * key in this plugin's own dictionary.
     *
     * The label a row shows is the *registrant's* localized text, and this
     * plugin deliberately does not change what other plugins call themselves.
     * An entry whose shipped name reads ambiguously next to the rest of the
     * sidebar is the exception: `plugins` opens the plugin directory, which is
     * easy to confuse with the plugin-ish sections inside Settings, so the menu
     * says which one it is.
     */
    const LABEL_OVERRIDES = {
      plugins: 'officialPlugins',
    };

    const ZH = {
      trigger: '全部面板',
      empty: '没有可显示的面板',
      failed: '打开失败',
      officialPlugins: '官方插件管理',
      archive: '历史归档',
    };
    const EN = {
      trigger: 'All panels',
      empty: 'Nothing to show',
      failed: 'Could not open',
      officialPlugins: 'Official plugin manager',
      archive: 'Archive',
    };

    const MENU_WIDTH = 236;
    const MENU_MAX_HEIGHT = 320;
    const FALLBACK_FONT =
      '13px/18px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

    /* ------------------------------------------------------------------ *
     * stylesheet: the rows live in the popover now                        *
     * ------------------------------------------------------------------ */

    const HIDE_CSS = [
      '/* dsh-panel-menu — the panel rows are reachable from the popover menu. */',
      NAV_SELECTOR + '{display:none !important}',
    ]
      .concat(PROXY_ENTRIES.map((entry) => entry.selector + '{display:none !important}'))
      .join('\n');

    /* ------------------------------------------------------------------ *
     * module-local menu state, shared by the trigger and the popover       *
     * ------------------------------------------------------------------ */

    const listeners = new Set();
    let menuState = { open: false, anchor: null, items: [], error: null };

    function setMenu(patch) {
      menuState = Object.assign({}, menuState, patch);
      listeners.forEach((notify) => {
        try {
          notify();
        } catch (err) {
          console.error('[dsh-panel-menu] menu listener failed', err);
        }
      });
    }

    function useMenuState() {
      const [, bump] = useState(0);
      useEffect(() => {
        const notify = () => bump((n) => n + 1);
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      }, []);
      return menuState;
    }

    /* ------------------------------------------------------------------ *
     * reading the panels                                                  *
     * ------------------------------------------------------------------ */

    /** All nodes matching a selector; a malformed selector is not fatal. */
    function all(selector) {
      try {
        return Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch (err) {
        console.error('[dsh-panel-menu] selector failed', selector, err);
        return [];
      }
    }

    /** A slot label may be a string or a thunk that follows the locale. */
    function labelOf(label, fallback) {
      try {
        if (typeof label === 'function') {
          const value = label();
          if (typeof value === 'string' && value) return value;
        }
      } catch (err) {
        console.error('[dsh-panel-menu] label thunk failed', err);
      }
      return typeof label === 'string' && label ? label : fallback;
    }

    /**
     * Every panel worth offering, freshly read at the moment the menu opens:
     * the slot ledger first, then the DOM-injected rows.
     */
    export function collectPanels(ctx, t) {
      const items = [];
      const seen = new Set();

      try {
        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : null);
        const ledger =
          slots && typeof slots.entriesOfSlot === 'function' ? slots.entriesOfSlot(PANEL_SLOT) : [];
        (ledger || []).forEach((entry, index) => {
          const options = (entry && entry.options) || {};
          const id = options.id;
          if (!id || id === TRIGGER_ID || seen.has(id)) return;
          seen.add(id);
          items.push({
            key: 'slot:' + id,
            label: LABEL_OVERRIDES[id] ? t(LABEL_OVERRIDES[id]) : labelOf(options.label, id),
            order: typeof options.order === 'number' ? options.order : index,
            panelId: id,
            run() {
              // `ctx.layout || ctx.get('layout')` is NOT enough: a plugin that did
              // not declare `layout` in its inject list throws on the property
              // access itself, so the right-hand side never runs. Catch it.
              let layout = null;
              try {
                layout = ctx.layout;
              } catch (err) {
                layout = null;
              }
              if (!layout && typeof ctx.get === 'function') layout = ctx.get('layout');
              if (!layout || typeof layout.selectPanel !== 'function') {
                throw new Error('layout.selectPanel is unavailable');
              }
              layout.selectPanel(id);
            },
          });
        });
      } catch (err) {
        console.error('[dsh-panel-menu] could not read the panel ledger', err);
      }

      PROXY_ENTRIES.forEach((spec, index) => {
        const nodes = all(spec.selector);
        if (nodes.length === 0) return;
        const domLabel = nodes[0].getAttribute ? nodes[0].getAttribute('aria-label') : null;
        items.push({
          key: 'dom:' + index,
          label: (domLabel && domLabel.trim()) || t(spec.labelKey),
          order: typeof spec.order === 'number' ? spec.order : 100 + index,
          isActive: () =>
            all(spec.selector).some(
              (node) =>
                node.hasAttribute(spec.activeAttr || 'data-active') ||
                node.getAttribute('aria-current') === 'page',
            ),
          run() {
            const target = all(spec.selector)[0];
            if (!target) throw new Error('the injected row is gone');
            target.click();
          },
        });
      });

      return items.sort((a, b) => a.order - b.order);
    }

    /** A DOM-backed item reports its own state; never let that throw. */
    function isItemActive(item, activePanelId) {
      if (typeof item.isActive === 'function') {
        try {
          return item.isActive() === true;
        } catch (err) {
          console.error('[dsh-panel-menu] active-state probe failed', item.key, err);
          return false;
        }
      }
      return item.panelId === activePanelId;
    }

    /* ------------------------------------------------------------------ *
     * glyphs                                                              *
     * ------------------------------------------------------------------ */

    function moreGlyph(size) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('circle', { key: 'a', cx: 3.2, cy: 8, r: 1.5 }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.5 }),
        h('circle', { key: 'c', cx: 12.8, cy: 8, r: 1.5 }),
      );
    }

    function checkGlyph(size) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d: 'M3 8.5 6.2 11.7 13 5' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * plugin body                                                         *
     * ------------------------------------------------------------------ */

/**
 * The original plugin body, verbatim.
 * @param ctx - the (possibly proxied) client context
 */
function applyBody(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'panel-menu: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'panel-menu: en dictionary');
        const t = ctx.locale.bind(NS);

        /** The sidebar-foot trigger: one button where five rows used to be. */
        function PanelMenuTrigger(props) {
          const snapshot = useMenuState();
          const wide = props.wide !== false;
          const size = wide ? 28 : 36;

          function onClick(event) {
            if (snapshot.open) {
              setMenu({ open: false });
              return;
            }
            let anchor = null;
            try {
              anchor = event.currentTarget.getBoundingClientRect();
            } catch (err) {
              console.error('[dsh-panel-menu] could not measure the trigger', err);
            }
            setMenu({ open: true, anchor, items: collectPanels(ctx, t), error: null });
          }

          return h(
            fragment(),
            null,
            /* The stylesheet rides the always-mounted trigger, so it is
             * present whether or not the menu is open. */
            h('style', { key: 'stylesheet' }, HIDE_CSS),
            h(
              'button',
              {
                key: 'trigger',
                type: 'button',
                className: 'dshpm-trigger',
                'aria-haspopup': 'true',
                'aria-expanded': snapshot.open ? 'true' : 'false',
                'aria-label': t('trigger'),
                title: t('trigger'),
                onClick,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: wide ? 'flex-start' : 'center',
                  gap: '6px',
                  flex: wide ? '1 1 auto' : '0 0 auto',
                  width: wide ? 'auto' : size + 'px',
                  height: size + 'px',
                  padding: wide ? '0 9px' : '0',
                  margin: wide ? '0 2px' : '0',
                  border: '0',
                  borderRadius: 'var(--dsw-radius-md, 8px)',
                  background: snapshot.open
                    ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))'
                    : 'transparent',
                  color: 'var(--dsw-alias-label-secondary, #6b7280)',
                  font: 'inherit',
                  fontSize: '13px',
                  lineHeight: '18px',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                },
              },
              moreGlyph(wide ? 16 : 18),
              wide ? h('span', { key: 'label' }, t('trigger')) : null,
            ),
          );
        }

        /** The popover itself, in the frame-wide overlay layer. */
        function PanelMenuOverlay(props) {
          const snapshot = useMenuState();
          const [hover, setHover] = useState(null);

          /* The shell hands every overlay entry the panel-selection hook, so
           * the row you are looking at can be marked. */
          const readPanelInfo = props.usePanelInfo;
          const activePanelId =
            typeof readPanelInfo === 'function'
              ? readPanelInfo((info) => (info ? info.activePanelId : null))
              : null;

          useEffect(() => {
            if (!snapshot.open) return undefined;
            function onKey(event) {
              if (event.key === 'Escape') setMenu({ open: false });
            }
            document.addEventListener('keydown', onKey);
            return () => document.removeEventListener('keydown', onKey);
          }, [snapshot.open]);

          if (!snapshot.open) return null;

          const anchor = snapshot.anchor;
          let left = 12;
          let bottom = 72;
          if (anchor) {
            left = Math.round(anchor.left);
            bottom = Math.round(window.innerHeight - anchor.top + 8);
          }
          left = Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8));

          const rows = snapshot.items.map((item) => {
            const active = isItemActive(item, activePanelId);
            const hovered = hover === item.key;
            return h(
              'button',
              {
                key: item.key,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': active ? 'true' : 'false',
                title: item.label,
                onMouseEnter: () => setHover(item.key),
                onMouseLeave: () => setHover((current) => (current === item.key ? null : current)),
                onClick: () => {
                  try {
                    item.run();
                    setMenu({ open: false, error: null });
                  } catch (err) {
                    /* A silent no-op reads as "the plugin is broken". Keep the
                     * menu open and say what failed instead. */
                    console.error('[dsh-panel-menu] could not open', item.key, err);
                    const detail = err && err.message ? err.message : String(err);
                    setMenu({ error: t('failed') + ' — ' + detail });
                  }
                },
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '7px 9px',
                  border: '0',
                  borderRadius: '8px',
                  background: hovered
                    ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))'
                    : 'transparent',
                  color: 'var(--dsw-alias-label-primary, #1f2329)',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                },
              },
              h(
                'span',
                {
                  key: 'label',
                  style: {
                    flex: '1 1 auto',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                item.label,
              ),
              active ? checkGlyph(14) : null,
            );
          });

          return h(
            'div',
            {
              key: 'backdrop',
              /* The overlay layer is click-through; this entry opts back in so
               * a click anywhere closes the menu. */
              style: { position: 'fixed', inset: '0', zIndex: 9998, pointerEvents: 'auto' },
              onMouseDown: () => setMenu({ open: false }),
              onContextMenu: (event) => {
                event.preventDefault();
                setMenu({ open: false });
              },
            },
            h(
              'div',
              {
                role: 'menu',
                'aria-label': t('trigger'),
                onMouseDown: (event) => event.stopPropagation(),
                style: {
                  position: 'fixed',
                  left: left + 'px',
                  bottom: bottom + 'px',
                  width: MENU_WIDTH + 'px',
                  maxHeight: MENU_MAX_HEIGHT + 'px',
                  overflowY: 'auto',
                  padding: '6px',
                  borderRadius: '12px',
                  background: 'var(--dsw-alias-bg-overlay, #ffffff)',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
                  color: 'var(--dsw-alias-label-primary, #1f2329)',
                  font: FALLBACK_FONT,
                  userSelect: 'none',
                },
              },
              /* No heading row: the trigger already says "All panels", and the
               * card opens straight onto the list. */
              snapshot.items.length === 0
                ? h(
                    'div',
                    {
                      key: 'empty',
                      style: {
                        padding: '6px 8px',
                        color: 'var(--dsw-alias-label-secondary, #6b7280)',
                      },
                    },
                    t('empty'),
                  )
                : rows,
              snapshot.error
                ? h(
                    'div',
                    {
                      key: 'error',
                      style: {
                        margin: '4px 2px 0',
                        padding: '6px 8px',
                        borderRadius: '8px',
                        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
                        color: 'var(--dsw-alias-state-error-primary, #d33)',
                        fontSize: '12px',
                        wordBreak: 'break-word',
                      },
                    },
                    snapshot.error,
                  )
                : null,
            ),
          );
        }

        ctx.effect(
          () =>
            ctx.slots.inject(TRIGGER_SLOT, () =>
              ctx.slots.register(
                { name: TRIGGER_SLOT, id: TRIGGER_ID, order: 60 },
                PanelMenuTrigger,
              ),
            ),
          'panel-menu: sidebar trigger',
        );

        ctx.effect(
          () =>
            ctx.slots.inject(OVERLAY_SLOT, () =>
              ctx.slots.register({ name: OVERLAY_SLOT, id: MENU_ID, order: 900 }, PanelMenuOverlay),
            ),
          'panel-menu: panel popover',
        );
}

/** Clear the shared menu state so a re-mount never reopens the old popover. */
export function resetMenuState() {
    try {
        setMenu({ open: false, anchor: null, items: [], error: null })
    } catch (error) {
        /* the store is rebuilt lazily; nothing to clear */
    }
}

/**
 * Mount the feature.
 *
 * `applyBody` is the original `apply`, unchanged, so it still calls `ctx.effect`.
 * The proxy turns every one of those into a tracked disposer: without it the
 * effects would attach to the client plugin fiber and survive a switch-off,
 * leaving the sidebar rows hidden forever.
 *
 * @param ctx - the client plugin context
 * @param env - the container environment
 * @returns a disposer that also clears the shared menu state
 */
export function mount(ctx, env) {
    resetMenuState()

    const scoped = new Proxy(ctx, {
        get(target, prop) {
            if (prop === 'effect') {
                return (fn, label) => env.track(target.effect(fn, label))
            }
            if (prop === 'layout') {
                // Declared inject is the fast path; ctx.get() is the safe one.
                try {
                    const declared = Reflect.get(target, prop)
                    if (declared) return declared
                } catch (error) {
                    /* not declared by this plugin: fall through */
                }
                return createDshAdapter(target).get('layout')
            }
            return Reflect.get(target, prop)
        },
    })

    applyBody(scoped)

    const dispose = () => resetMenuState()
    env.track(dispose)
    return dispose
}

