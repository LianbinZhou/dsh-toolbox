"use strict";
(() => {
  // src/client/runtime.js
  var runtime;
  function installRuntime(react) {
    if (react === null || typeof react !== "object" || typeof react.createElement !== "function") {
      throw new TypeError("dsh-toolbox: the module loader did not hand over a React runtime");
    }
    runtime = react;
    return runtime;
  }
  function getRuntime() {
    if (runtime === void 0) throw new Error("dsh-toolbox: runtime not installed yet");
    return runtime;
  }
  function h(...args) {
    return getRuntime().createElement(...args);
  }
  function useState(...args) {
    return getRuntime().useState(...args);
  }
  function useEffect(...args) {
    return getRuntime().useEffect(...args);
  }
  function useCallback(...args) {
    return getRuntime().useCallback(...args);
  }
  function useRef(...args) {
    return getRuntime().useRef(...args);
  }
  function fragment() {
    return getRuntime().Fragment;
  }

  // src/client/scope.js
  function toDisposer(value) {
    if (value === void 0 || value === null) return null;
    if (typeof value === "function") return value;
    if (typeof value.dispose === "function") return () => value.dispose();
    throw new TypeError("dsh-toolbox: a disposer must be a function or expose dispose()");
  }
  function createScope(label = "scope") {
    const undo = [];
    const seen = /* @__PURE__ */ new WeakSet();
    let closed = false;
    function run(disposer, pending) {
      const result = disposer();
      if (result && typeof result.then === "function") {
        pending.push(
          Promise.resolve(result).catch((error) => {
            console.error("[dsh-toolbox] async disposer failed in " + label, error);
          })
        );
      }
    }
    return {
      label,
      /** Register one disposer. Returns it unchanged so callers can keep a handle. */
      track(value) {
        const disposer = toDisposer(value);
        if (disposer === null) return value;
        if (closed) {
          const sink = [];
          try {
            run(disposer, sink);
          } catch (error) {
            console.error("[dsh-toolbox] late disposer failed in " + label, error);
          }
          return value;
        }
        if (seen.has(disposer)) return value;
        seen.add(disposer);
        undo.push(disposer);
        return value;
      },
      /** How many effects are currently held. Used by the tests. */
      size() {
        return undo.length;
      },
      /**
       * Undo everything, newest first, each isolated.
       * @returns a promise that settles when the asynchronous disposers are done
       */
      dispose() {
        if (closed) return Promise.resolve();
        closed = true;
        const pending = [];
        let first;
        for (const disposer of undo.splice(0).reverse()) {
          try {
            run(disposer, pending);
          } catch (error) {
            if (first === void 0) first = error;
            console.error("[dsh-toolbox] disposer failed in " + label, error);
          }
        }
        if (first !== void 0) throw first;
        return Promise.all(pending);
      }
    };
  }

  // src/client/container.js
  var OFF = "off";
  var MOUNTING = "mounting";
  var MOUNTED = "mounted";
  function createContainer(options) {
    const {
      features,
      ctx,
      env = {},
      readSwitches: readSwitches2,
      cachedSwitches,
      watchSwitches: watchSwitches2,
      onError = (id, error) => console.error("[dsh-toolbox] " + id, error)
    } = options;
    const state = /* @__PURE__ */ new Map();
    const scopes = /* @__PURE__ */ new Map();
    const generation = /* @__PURE__ */ new Map();
    const pendingDisposals = [];
    let disposed = false;
    let settingsReady = false;
    let queue = Promise.resolve();
    let values = {};
    let markReady;
    let readyDone = false;
    const ready = new Promise((resolve) => {
      markReady = () => {
        if (readyDone) return;
        readyDone = true;
        resolve();
      };
    });
    const isCancelled = () => disposed;
    const wantOf = (feature, source) => source[feature.configKey] === true;
    function reversibleOnly(cache) {
      if (!cache || typeof cache !== "object") return {};
      const out = {};
      for (const feature of features) {
        if (feature.reversible && cache[feature.configKey] === true) out[feature.configKey] = true;
      }
      return out;
    }
    function disposeScope(scope) {
      try {
        const result = scope.dispose();
        if (result && typeof result.then === "function") {
          pendingDisposals.push(
            Promise.resolve(result).catch((error) => {
              onError(scope.label, error);
            })
          );
        }
      } catch (error) {
        onError(scope.label, error);
      }
    }
    function mountFeature(feature) {
      const mine = (generation.get(feature.id) ?? 0) + 1;
      generation.set(feature.id, mine);
      state.set(feature.id, MOUNTING);
      const scope = createScope(feature.id);
      const scopedEnv = Object.assign({}, env, { track: (value) => scope.track(value) });
      try {
        scope.track(feature.mount(ctx, scopedEnv));
      } catch (error) {
        onError(feature.id, error);
        disposeScope(scope);
        state.set(feature.id, OFF);
        return;
      }
      const superseded = disposed || generation.get(feature.id) !== mine || !wantOf(feature, values);
      if (superseded) {
        disposeScope(scope);
        state.set(feature.id, OFF);
        return;
      }
      scopes.set(feature.id, scope);
      state.set(feature.id, MOUNTED);
    }
    function unmountFeature(feature) {
      generation.set(feature.id, (generation.get(feature.id) ?? 0) + 1);
      const scope = scopes.get(feature.id);
      scopes.delete(feature.id);
      state.set(feature.id, OFF);
      if (scope) disposeScope(scope);
    }
    function reconcile(next) {
      if (disposed) return;
      values = next && typeof next === "object" ? next : {};
      for (const feature of features) {
        const want = wantOf(feature, values);
        const phase = state.get(feature.id) ?? OFF;
        if (!feature.reversible) {
          if (!settingsReady) continue;
          if (values[feature.configKey] === void 0) continue;
        }
        if (want && phase === OFF) mountFeature(feature);
        else if (!want && (phase === MOUNTED || phase === MOUNTING)) unmountFeature(feature);
      }
    }
    function flushDisposals() {
      return Promise.all(pendingDisposals.splice(0)).then(() => void 0);
    }
    function schedule(next) {
      queue = queue.then(() => {
        if (!disposed) reconcile(next);
        return flushDisposals();
      }).catch((error) => onError("container", error));
      return queue;
    }
    function start() {
      if (typeof cachedSwitches === "function") {
        schedule(reversibleOnly(safeCall(cachedSwitches, onError)));
      }
      let settled;
      try {
        settled = Promise.resolve(readSwitches2(ctx, { isCancelled }));
      } catch (error) {
        settled = Promise.reject(error);
      }
      settled.then((next) => {
        settingsReady = true;
        return schedule(next);
      }).then(() => markReady()).catch((error) => {
        onError("settings", error);
        settingsReady = true;
        schedule({}).then(() => markReady());
      });
      const off = typeof watchSwitches2 === "function" ? watchSwitches2(ctx, (next) => schedule(next), { isCancelled }) : void 0;
      return off;
    }
    function dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      markReady();
      for (const [, scope] of scopes) disposeScope(scope);
      scopes.clear();
      state.clear();
      return flushDisposals();
    }
    const stopWatching = start();
    return {
      /** Queue new switch values (production path). */
      feed: (next) => schedule(next),
      /** Reconcile immediately, inside the current call. Used to test real re-entry. */
      feedSync: (next) => reconcile(next),
      phaseOf: (id) => state.get(id) ?? OFF,
      liveCount: () => scopes.size,
      /** Resolves after the queue and every async disposal has settled. */
      settled: () => queue.then(() => flushDisposals()),
      /** Resolves after the first reconcile driven by the real switch values. */
      ready: () => ready,
      dispose() {
        try {
          if (typeof stopWatching === "function") stopWatching();
          else if (stopWatching && typeof stopWatching.dispose === "function") stopWatching.dispose();
        } catch (error) {
          onError("watch", error);
        }
        return dispose();
      }
    };
  }
  function safeCall(fn, onError) {
    try {
      return fn();
    } catch (error) {
      onError("cache", error);
      return void 0;
    }
  }

  // src/client/registry.js
  function defineFeature(spec) {
    if (!spec || typeof spec !== "object") throw new TypeError("feature spec must be an object");
    const { id, configKey, title, mount: mount5, reversible } = spec;
    if (typeof id !== "string" || id.length === 0) throw new TypeError("feature needs a string id");
    if (typeof configKey !== "string" || configKey.length === 0) {
      throw new TypeError("feature " + id + " needs a configKey");
    }
    if (typeof mount5 !== "function") throw new TypeError("feature " + id + " needs mount()");
    if (typeof reversible !== "boolean") {
      throw new TypeError("feature " + id + " must declare reversible: true|false");
    }
    return Object.freeze({ id, configKey, title: title ?? id, mount: mount5, reversible });
  }
  function defineFeatures(list) {
    const ids = /* @__PURE__ */ new Set();
    const keys = /* @__PURE__ */ new Set();
    return list.map((spec) => {
      const feature = defineFeature(spec);
      if (ids.has(feature.id)) throw new Error("duplicate feature id: " + feature.id);
      if (keys.has(feature.configKey)) throw new Error("duplicate configKey: " + feature.configKey);
      ids.add(feature.id);
      keys.add(feature.configKey);
      return feature;
    });
  }

  // src/client/features/quote-reply.js
  var NS = "dsh-quote-reply";
  var OVERLAY_SLOT = "shell.overlay";
  var SINK_SLOT = "conversation.input.overlay";
  var MENU_ID = "quote-reply.menu";
  var SINK_ID = "quote-reply.sink";
  var MENU_W = 158;
  var MENU_H = 40;
  var GAP = 8;
  var ZH = { quote: "引用", copy: "复制", copied: "已复制" };
  var EN = { quote: "Quote", copy: "Copy", copied: "Copied" };
  var sinkHandlers = /* @__PURE__ */ new Set();
  function dispatchQuote(text) {
    let handled = false;
    sinkHandlers.forEach((fn) => {
      try {
        if (fn(text)) handled = true;
      } catch (err) {
        console.error("[dsh-quote-reply] composer sink failed", err);
      }
    });
    return handled;
  }
  function normalizeQuote(raw) {
    return String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function toQuoteBlock(raw) {
    const body = normalizeQuote(raw);
    if (!body) return "";
    return body.split("\n").map((line) => line ? "> " + line : ">").join("\n");
  }
  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }
  function commonTable(sel) {
    const startEl = elementOf(sel.anchorNode);
    const endEl = elementOf(sel.focusNode);
    const a = startEl && typeof startEl.closest === "function" ? startEl.closest("table") : null;
    const b = endEl && typeof endEl.closest === "function" ? endEl.closest("table") : null;
    return a && a === b ? a : null;
  }
  function cellText(cell) {
    return String(cell.textContent || "").replace(/\s+/g, " ").trim();
  }
  function selectionTableMarkdown(sel) {
    const table = commonTable(sel);
    if (!table) return "";
    let range = null;
    try {
      range = sel.getRangeAt(0);
    } catch (err) {
      return "";
    }
    const rows = [];
    for (let i = 0; i < table.rows.length; i += 1) {
      const row = table.rows[i];
      let hit = false;
      try {
        hit = range.intersectsNode(row);
      } catch (err) {
        hit = false;
      }
      if (hit) rows.push(row);
    }
    if (rows.length === 0) return "";
    const isHeaderRow = (row) => Array.prototype.some.call(row.cells, (cell) => cell.tagName === "TH");
    if (rows.length === 1 && !isHeaderRow(rows[0])) return "";
    const grid = rows.map((row) => Array.prototype.map.call(row.cells, cellText));
    const width = grid.reduce((max, cells) => Math.max(max, cells.length), 0);
    if (width === 0) return "";
    const padded = grid.map((cells) => {
      const out = cells.slice();
      while (out.length < width) out.push("");
      return out;
    });
    const escape = (text) => text.replace(/\|/g, "\\|");
    const line = (cells) => "| " + cells.map(escape).join(" | ") + " |";
    const header = padded[0];
    const divider = "| " + header.map(() => "---").join(" | ") + " |";
    return [line(header), divider].concat(padded.slice(1).map(line)).join("\n");
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        return navigator.clipboard.writeText(text).then(
          () => true,
          () => legacyCopy(text)
        );
      }
    } catch (err) {
    }
    return Promise.resolve(legacyCopy(text));
  }
  function isEditableNode(node) {
    let el = node;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest(
      'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
    );
  }
  function QuoteMenu(props) {
    const t = props.t;
    const [menu, setMenu2] = useState(null);
    const [hover, setHover] = useState(null);
    const boxRef = useRef(null);
    const openRef = useRef(false);
    const closeTimer = useRef(null);
    const close = useCallback(() => {
      if (closeTimer.current) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (!openRef.current) return;
      openRef.current = false;
      setHover(null);
      setMenu2(null);
    }, []);
    useEffect(() => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    }, []);
    useEffect(() => {
      function place(sel, fallbackX, fallbackY) {
        let rect = null;
        try {
          rect = sel.getRangeAt(0).getBoundingClientRect();
        } catch (err) {
          rect = null;
        }
        const usable = !!rect && (rect.width > 0 || rect.height > 0);
        const left = usable ? rect.left : fallbackX;
        const top = usable ? rect.top : fallbackY;
        const bottom = usable ? rect.bottom : fallbackY;
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const x = Math.max(GAP, Math.min(left, Math.max(GAP, vw - MENU_W - GAP)));
        let y = top - MENU_H - GAP;
        if (y < GAP) y = Math.min(Math.max(GAP, vh - MENU_H - GAP), bottom + GAP);
        return { x: Math.round(x), y: Math.round(y) };
      }
      function captureFromSelection(fallbackX, fallbackY) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const raw = sel.toString();
        if (isEditableNode(sel.anchorNode) || isEditableNode(sel.focusNode)) return;
        const quoted = selectionTableMarkdown(sel) || normalizeQuote(raw);
        if (!quoted) return;
        const pos = place(sel, fallbackX, fallbackY);
        openRef.current = true;
        setHover(null);
        setMenu2({ x: pos.x, y: pos.y, raw, quoted, status: null });
      }
      function onMouseUp(e) {
        if (e.button !== 0) return;
        if (boxRef.current && boxRef.current.contains(e.target)) return;
        const x = e.clientX;
        const y = e.clientY;
        window.setTimeout(() => captureFromSelection(x, y), 0);
      }
      function onMouseDown(e) {
        if (boxRef.current && boxRef.current.contains(e.target)) return;
        close();
      }
      function onContextMenu() {
        close();
      }
      function onKeyDown(e) {
        if (e.key === "Escape") close();
      }
      function onSelectionChange() {
        if (!openRef.current) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) close();
      }
      document.addEventListener("mouseup", onMouseUp, true);
      document.addEventListener("mousedown", onMouseDown, true);
      document.addEventListener("contextmenu", onContextMenu, true);
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("selectionchange", onSelectionChange);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
      return () => {
        document.removeEventListener("mouseup", onMouseUp, true);
        document.removeEventListener("mousedown", onMouseDown, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("selectionchange", onSelectionChange);
        window.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
      };
    }, [close]);
    if (!menu) return null;
    function markCopied() {
      setMenu2((m) => m ? { ...m, status: "copied" } : m);
      closeTimer.current = window.setTimeout(close, 800);
    }
    function onQuote() {
      if (!menu) return;
      if (dispatchQuote(menu.quoted)) {
        close();
        return;
      }
      copyText(menu.raw).then(markCopied);
    }
    function onCopy() {
      if (!menu) return;
      copyText(menu.raw).then((ok) => {
        if (!ok) {
          close();
          return;
        }
        markCopied();
      });
    }
    function icon(children) {
      return h(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          style: { display: "block", flex: "0 0 auto" }
        },
        children
      );
    }
    function item(key, label, glyph, onClick) {
      return h(
        "button",
        {
          type: "button",
          key,
          onMouseDown: (e) => e.preventDefault(),
          onClick,
          onMouseEnter: () => setHover(key),
          onMouseLeave: () => setHover((cur) => cur === key ? null : cur),
          style: {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "5px 9px",
            border: "0",
            borderRadius: "7px",
            background: hover === key ? "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))" : "transparent",
            color: "var(--dsw-alias-label-primary, #1f2329)",
            font: "inherit",
            fontSize: "13px",
            lineHeight: "18px",
            whiteSpace: "nowrap",
            cursor: "pointer"
          }
        },
        glyph,
        h("span", null, label)
      );
    }
    const copied = menu.status === "copied";
    return h(
      "div",
      {
        ref: boxRef,
        role: "toolbar",
        style: {
          position: "fixed",
          left: menu.x + "px",
          top: menu.y + "px",
          zIndex: 9999,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: "2px",
          padding: "4px",
          borderRadius: "10px",
          background: "var(--dsw-alias-bg-overlay, #ffffff)",
          border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10))",
          boxShadow: "0 6px 20px rgba(0, 0, 0, 0.16)",
          color: "var(--dsw-alias-label-primary, #1f2329)",
          font: '13px/18px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          userSelect: "none"
        }
      },
      item(
        "quote",
        t("quote"),
        icon(h("polyline", { points: "9 14 4 9 9 4" }), h("path", { d: "M20 20v-7a4 4 0 0 0-4-4H4" })),
        onQuote
      ),
      h("div", {
        style: {
          width: "1px",
          alignSelf: "stretch",
          margin: "2px 1px",
          background: "var(--dsw-alias-border-l1, rgba(0,0,0,0.10))"
        }
      }),
      item(
        "copy",
        copied ? t("copied") : t("copy"),
        icon(
          h("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
          h("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
        ),
        onCopy
      )
    );
  }
  function QuoteSink(props) {
    const propsRef = useRef(props);
    propsRef.current = props;
    const readInput = props.useInput;
    const input = typeof readInput === "function" ? readInput((s) => s) : null;
    const inputRef = useRef(input);
    inputRef.current = input;
    useEffect(() => {
      function handler(raw) {
        const p = propsRef.current || {};
        const actions = p.inputActions;
        if (!actions) return false;
        const block = toQuoteBlock(raw);
        if (!block) return false;
        const live = inputRef.current;
        const draft = live && typeof live.draft === "string" ? live.draft : null;
        const chips = live && Array.isArray(live.occurrences) ? live.occurrences.length : 0;
        let at = draft === null ? 0 : draft.length;
        if (draft !== null && typeof actions.captureInsertion === "function") {
          try {
            const span2 = actions.captureInsertion();
            const revOk = span2 && live && span2.draftRev === live.draftRev;
            const collapsed = span2 && span2.start === span2.end;
            const inRange = span2 && span2.start >= 0 && span2.start <= draft.length;
            if (revOk && collapsed && inRange) at = span2.start;
          } catch (err) {
            at = draft.length;
          }
        }
        const prefix = draft === null ? "" : draft.slice(0, at);
        const lead = prefix !== "" && !prefix.endsWith("\n") ? "\n" : "";
        const payload = lead + block + "\n\n";
        if (draft !== null && chips === 0 && typeof actions.setDraft === "function") {
          try {
            actions.setDraft(prefix + payload + draft.slice(at));
            return true;
          } catch (err) {
            console.error("[dsh-quote-reply] setDraft failed, falling back to insertText", err);
          }
        }
        if (typeof actions.insertText !== "function") return false;
        let span = null;
        try {
          span = actions.captureInsertion();
        } catch (err) {
          span = null;
        }
        if (!span) return false;
        try {
          if (actions.insertText(payload, span)) return true;
        } catch (err) {
          console.error("[dsh-quote-reply] insertText failed", err);
        }
        return false;
      }
      sinkHandlers.add(handler);
      return () => {
        sinkHandlers.delete(handler);
      };
    }, []);
    return null;
  }
  function mount(ctx, env) {
    const t = ctx.locale.bind(NS);
    env.track(ctx.effect(() => ctx.locale.register(NS, "zh", ZH), "quote-reply: zh dictionary"));
    env.track(ctx.effect(() => ctx.locale.register(NS, "en", EN), "quote-reply: en dictionary"));
    env.track(
      ctx.effect(
        () => ctx.slots.inject(
          OVERLAY_SLOT,
          () => ctx.slots.register({ name: OVERLAY_SLOT, id: MENU_ID, order: 60 }, function QuoteMenuEntry() {
            return h(QuoteMenu, { t });
          })
        ),
        "quote-reply: selection menu"
      )
    );
    env.track(
      ctx.effect(
        () => ctx.slots.inject(SINK_SLOT, () => ctx.slots.register({ name: SINK_SLOT, id: SINK_ID, order: 300 }, QuoteSink)),
        "quote-reply: composer sink"
      )
    );
  }

  // src/client/features/draft-guard.js
  var BACKUP_KEY = "dsh-draft-saver.backup.v1";
  var DRAFT_PREFIX = "dsh.conversation.";
  var PATCH_MARK = /* @__PURE__ */ Symbol.for("dsh.draft-saver.patch");
  var MAX_LAST_READ = 512;
  var EMPTY_DRAFT = JSON.stringify({ draft: { text: "", references: [] }, view: null, viewRequest: null });
  var LIVE = /* @__PURE__ */ new WeakMap();
  function readDraftValue(raw) {
    if (typeof raw !== "string") return { ok: false };
    try {
      const parsed = JSON.parse(raw);
      const draft = parsed && parsed.draft;
      if (!draft || typeof draft !== "object") return { ok: false };
      const text = typeof draft.text === "string" ? draft.text : "";
      return { ok: true, text, references: Array.isArray(draft.references) ? draft.references : [] };
    } catch (error) {
      return { ok: false };
    }
  }
  function draftTextOf(raw) {
    const parsed = readDraftValue(raw);
    return parsed.ok ? parsed.text : "";
  }
  function previewOf(text) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
  }
  function markPatch(wrapper) {
    try {
      Object.defineProperty(wrapper, PATCH_MARK, { value: true, enumerable: false });
    } catch (error) {
    }
    return wrapper;
  }
  function installDraftGuard(getStorage, options = {}) {
    const { onRestore, allowPrototypeFallback = false } = options;
    const first = typeof getStorage === "function" ? getStorage() : getStorage;
    if (!first || typeof first.getItem !== "function" || typeof first.setItem !== "function") {
      return { dispose() {
      }, status: "unavailable", patched: false, reused: false, reason: "no storage" };
    }
    const existing = LIVE.get(first);
    if (existing) {
      return {
        dispose() {
        },
        status: existing.status,
        patched: existing.patched,
        reused: true,
        mode: existing.mode,
        reason: "already patched by this module"
      };
    }
    if (first.setItem && first.setItem[PATCH_MARK]) {
      return {
        dispose() {
        },
        status: "conflict",
        patched: false,
        reused: false,
        reason: "a draft guard is already installed on this storage"
      };
    }
    const second = typeof getStorage === "function" ? getStorage() : first;
    const unstable = second !== first;
    const original = { getItem: first.getItem, setItem: first.setItem };
    const hadOwn = {
      getItem: Object.prototype.hasOwnProperty.call(first, "getItem"),
      setItem: Object.prototype.hasOwnProperty.call(first, "setItem")
    };
    const state = {
      active: true,
      lastRead: /* @__PURE__ */ new Map(),
      status: "patched"
    };
    function backupRead() {
      try {
        const raw = original.getItem.call(first, BACKUP_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.raw !== "string" || typeof parsed.key !== "string") return null;
        if (!String(parsed.key).startsWith(DRAFT_PREFIX)) return null;
        if (!readDraftValue(parsed.raw).ok) return null;
        return parsed;
      } catch (error) {
        return null;
      }
    }
    function backupWrite(record) {
      try {
        original.setItem.call(first, BACKUP_KEY, JSON.stringify(record));
      } catch (error) {
      }
    }
    function publish(notice) {
      if (!state.active) return;
      if (typeof onRestore !== "function") return;
      try {
        onRestore(notice);
      } catch (error) {
        console.error("[dsh-toolbox] draft notice failed", error);
      }
    }
    function onWrite(key, value) {
      const parsed = readDraftValue(value);
      if (!parsed.ok) return;
      const seen = state.lastRead.get(key);
      const text = parsed.text;
      const existingBackup = backupRead();
      if (text.trim() !== "") {
        if (typeof seen === "string" && draftTextOf(seen) === text) return;
        if (existingBackup && existingBackup.key === key && existingBackup.raw === value) return;
        backupWrite({ v: 1, at: Date.now(), key, raw: value, chars: text.length, preview: previewOf(text) });
        return;
      }
      if (text === "") {
        backupWrite({ v: 1, at: Date.now(), key, raw: EMPTY_DRAFT, chars: 0, preview: "" });
      }
    }
    function decideRead(key, raw) {
      const backup = backupRead();
      if (!backup) return raw;
      const newest = draftTextOf(backup.raw);
      const own = raw === null ? "" : draftTextOf(raw);
      if (own === newest) return raw;
      if (newest.trim() === "") return own.trim() === "" ? raw : backup.raw;
      publish({ at: Date.now(), chars: backup.chars, preview: backup.preview, text: newest });
      return backup.raw;
    }
    function onRead(key, raw) {
      const answer = decideRead(key, raw);
      if (state.lastRead.size > MAX_LAST_READ) state.lastRead.clear();
      state.lastRead.set(key, answer);
      return answer;
    }
    const isMine = (target) => target === first;
    function makeSetItem(invoke) {
      return markPatch(function dshDraftSaverSetItem(key, value) {
        const result = invoke(this, key, value);
        if (!state.active || this !== first) return result;
        const name = String(key);
        if (!name.startsWith(DRAFT_PREFIX)) return result;
        try {
          onWrite(name, String(value));
        } catch (error) {
          console.error("[dsh-toolbox] draft mirror failed", error);
        }
        return result;
      });
    }
    function makeGetItem(invoke) {
      return markPatch(function dshDraftSaverGetItem(key) {
        const raw = invoke(this, key);
        if (!state.active || this !== first) return raw;
        const name = String(key);
        if (!name.startsWith(DRAFT_PREFIX)) return raw;
        try {
          return onRead(name, raw);
        } catch (error) {
          console.error("[dsh-toolbox] draft restore failed", error);
          return raw;
        }
      });
    }
    let mode = "instance";
    let patched = false;
    let protoSetRef;
    let protoGetRef;
    let protoSetWrapper;
    let protoGetWrapper;
    const instanceSet = makeSetItem(function(self, key, value) {
      return original.setItem.call(self, key, value);
    });
    const instanceGet = makeGetItem(function(self, key) {
      return original.getItem.call(self, key);
    });
    if (!unstable) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(first, "setItem");
        if (descriptor && descriptor.writable === false) throw new TypeError("setItem is not writable");
        first.setItem = instanceSet;
        first.getItem = instanceGet;
        patched = first.setItem === instanceSet && first.getItem === instanceGet;
        if (!patched) throw new TypeError("the instance refused the patch");
      } catch (error) {
        try {
          if (first.setItem === instanceSet) delete first.setItem;
          if (first.getItem === instanceGet) delete first.getItem;
        } catch (cleanupError) {
        }
        state.status = "unsupported";
        patched = false;
      }
    } else if (allowPrototypeFallback) {
      const proto = Object.getPrototypeOf(first);
      protoSetRef = proto.setItem;
      protoGetRef = proto.getItem;
      protoSetWrapper = makeSetItem(function(self, key, value) {
        return protoSetRef.call(self, key, value);
      });
      protoGetWrapper = makeGetItem(function(self, key) {
        return protoGetRef.call(self, key);
      });
      const guardedSet = markPatch(function dshDraftSaverProtoSetItem(key, value) {
        const result = protoSetRef.call(this, key, value);
        if (!state.active || !isMine(this)) return result;
        const name = String(key);
        if (!name.startsWith(DRAFT_PREFIX)) return result;
        try {
          onWrite(name, String(value));
        } catch (error) {
          console.error("[dsh-toolbox] draft mirror failed", error);
        }
        return result;
      });
      const guardedGet = markPatch(function dshDraftSaverProtoGetItem(key) {
        const raw = protoGetRef.call(this, key);
        if (!state.active || !isMine(this)) return raw;
        const name = String(key);
        if (!name.startsWith(DRAFT_PREFIX)) return raw;
        try {
          return onRead(name, raw);
        } catch (error) {
          return raw;
        }
      });
      try {
        proto.setItem = guardedSet;
        proto.getItem = guardedGet;
        protoSetWrapper = guardedSet;
        protoGetWrapper = guardedGet;
        patched = proto.setItem === guardedSet && proto.getItem === guardedGet;
        mode = "prototype";
        if (!patched) state.status = "unsupported";
      } catch (error) {
        state.status = "unsupported";
        patched = false;
      }
    } else {
      state.status = "unstable";
    }
    const handle = {
      get status() {
        return state.status;
      },
      get active() {
        return state.active;
      },
      patched,
      reused: false,
      mode,
      dispose() {
        if (!state.active) return;
        state.active = false;
        LIVE.delete(first);
        if (!patched) return;
        try {
          if (mode === "instance") {
            const ours = first.setItem === instanceSet || first.getItem === instanceGet;
            const theirs = first.setItem !== void 0 && first.setItem !== instanceSet || first.getItem !== void 0 && first.getItem !== instanceGet;
            if (theirs) {
              state.status = "needs-refresh";
              console.warn("[dsh-toolbox] draft guard: a later patch replaced ours; leaving it in place");
              return;
            }
            if (!ours) return;
            if (first.setItem === instanceSet) {
              if (hadOwn.setItem) first.setItem = original.setItem;
              else delete first.setItem;
            }
            if (first.getItem === instanceGet) {
              if (hadOwn.getItem) first.getItem = original.getItem;
              else delete first.getItem;
            }
          } else {
            const proto = Object.getPrototypeOf(first);
            if (proto.setItem !== protoSetWrapper || proto.getItem !== protoGetWrapper) {
              state.status = "needs-refresh";
              return;
            }
            proto.setItem = protoSetRef;
            proto.getItem = protoGetRef;
          }
        } catch (error) {
          state.status = "needs-refresh";
          console.error("[dsh-toolbox] draft guard restore failed", error);
        }
      }
    };
    if (patched) LIVE.set(first, handle);
    return handle;
  }

  // src/client/features/draft-notice.js
  var NS2 = "dsh-toolbox.draft-saver";
  var NOTICE_SLOT = "conversation.input.overlay";
  var NOTICE_ID = "draft-saver.notice";
  var AUTO_DISMISS_MS = 2e4;
  var ZH2 = {
    notice: "已恢复上次未发送的草稿（{chars} 字）",
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败",
    clear: "清空",
    dismiss: "知道了",
    hint: "来自上一个会话、还没发送的内容；你可以直接改、发出去，或点清空丢掉它。"
  };
  var EN2 = {
    notice: "Restored an unsent draft ({chars} chars)",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    clear: "Clear",
    dismiss: "Got it",
    hint: "Text from an earlier session that was never sent; edit it, send it, or clear it away."
  };
  function createNoticeBus() {
    let current = null;
    const listeners2 = /* @__PURE__ */ new Set();
    return {
      get() {
        return current;
      },
      publish(next) {
        current = next ?? null;
        for (const listener of Array.from(listeners2)) {
          try {
            listener();
          } catch (error) {
            console.error("[dsh-toolbox] draft notice listener failed", error);
          }
        }
      },
      subscribe(listener) {
        listeners2.add(listener);
        return () => {
          listeners2.delete(listener);
        };
      },
      dispose() {
        listeners2.clear();
        current = null;
      }
    };
  }
  function previewOf2(text) {
    const flat = String(text).replace(/\s+/g, " ").trim();
    return flat.length > 60 ? flat.slice(0, 60) + "…" : flat;
  }
  function isMyNotice(snapshot, draft) {
    return Boolean(
      snapshot && typeof snapshot.text === "string" && snapshot.text !== "" && draft !== null && typeof draft === "string" && (draft === snapshot.text || draft.startsWith(snapshot.text))
    );
  }
  async function copyText2(text) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "0";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const done = document.execCommand("copy");
      document.body.removeChild(area);
      return done === true;
    } catch (error) {
      return false;
    }
  }
  var BUTTON_STYLE = {
    appearance: "none",
    border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    padding: "2px 8px",
    borderRadius: "7px",
    cursor: "pointer"
  };
  function createNoticeComponent(bus, t) {
    return function DraftSaverNotice(props) {
      const [snapshot, setSnapshot] = useState(bus.get());
      const [copied, setCopied] = useState("");
      const copyTimer = useRef(null);
      useEffect(() => {
        return () => {
          if (copyTimer.current) clearTimeout(copyTimer.current);
        };
      }, []);
      useEffect(() => {
        const sync = () => setSnapshot(bus.get());
        const off = bus.subscribe(sync);
        sync();
        return off;
      }, []);
      useEffect(() => {
        if (!snapshot) return void 0;
        const timer = setTimeout(() => bus.publish(null), AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
      }, [snapshot]);
      const readInput = props.useInput;
      const input = typeof readInput === "function" ? readInput((state) => state) : null;
      const draft = input && typeof input.draft === "string" ? input.draft : null;
      const actions = props.inputActions;
      if (!isMyNotice(snapshot, draft)) return null;
      const copy = () => {
        copyText2(draft).then((done) => {
          setCopied(done ? "copied" : "failed");
          bus.publish(Object.assign({}, snapshot));
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(""), 1800);
        });
      };
      const clear = () => {
        try {
          if (actions && typeof actions.setDraft === "function") actions.setDraft("");
        } catch (error) {
          console.error("[dsh-toolbox] clearing the restored draft failed", error);
        }
        bus.publish(null);
      };
      return h(
        "div",
        {
          "data-draft-saver": "notice",
          style: {
            position: "fixed",
            left: "50%",
            bottom: "104px",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            maxWidth: "min(620px, calc(100vw - 32px))",
            padding: "8px 12px",
            borderRadius: "10px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
            background: "var(--dsw-alias-bg-overlay, rgba(28,28,30,0.96))",
            color: "var(--dsw-alias-label-primary, #f5f5f5)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.3)",
            fontSize: "12.5px",
            lineHeight: "1.4",
            zIndex: 60
          }
        },
        [
          h(
            "span",
            { key: "text", title: snapshot.preview || "", style: { flex: "1 1 auto", minWidth: "0" } },
            t("notice", { chars: snapshot.chars })
          ),
          h(
            "button",
            { key: "copy", type: "button", style: BUTTON_STYLE, title: t("hint"), onClick: copy },
            copied === "copied" ? t("copied") : copied === "failed" ? t("copyFailed") : t("copy")
          ),
          h("button", { key: "clear", type: "button", style: BUTTON_STYLE, title: t("hint"), onClick: clear }, t("clear")),
          h("button", { key: "dismiss", type: "button", style: BUTTON_STYLE, onClick: () => bus.publish(null) }, t("dismiss"))
        ]
      );
    };
  }
  function mountNotice(ctx, env, bus) {
    const t = ctx.locale.bind(NS2);
    env.track(ctx.effect(() => ctx.locale.register(NS2, "zh", ZH2), "draft-saver: zh dictionary"));
    env.track(ctx.effect(() => ctx.locale.register(NS2, "en", EN2), "draft-saver: en dictionary"));
    env.track(
      ctx.effect(
        () => ctx.slots.inject(
          NOTICE_SLOT,
          () => ctx.slots.register({ name: NOTICE_SLOT, id: NOTICE_ID, order: 320 }, function DraftSaverNoticeEntry(props) {
            const Notice = createNoticeComponent(bus, t);
            return h(Notice, props);
          })
        ),
        "draft-saver: restored-draft notice"
      )
    );
  }

  // src/client/features/draft-saver.js
  function mount2(ctx, env) {
    const bus = createNoticeBus();
    const getStorage = () => {
      try {
        return typeof window !== "undefined" ? window.localStorage : void 0;
      } catch (error) {
        return void 0;
      }
    };
    const handle = installDraftGuard(getStorage, {
      onRestore: (notice) => {
        bus.publish({
          at: notice.at,
          chars: notice.chars,
          text: notice.text ?? "",
          preview: notice.preview || previewOf2(notice.text ?? "")
        });
      }
    });
    if (handle.status !== "patched") {
      console.warn("[dsh-toolbox] draft guard not active: " + handle.status + (handle.reason ? " (" + handle.reason + ")" : ""));
    } else {
      mountNotice(ctx, env, bus);
    }
    try {
      if (typeof window !== "undefined") {
        window.__DSH_TOOLBOX_DRAFT__ = {
          status: handle.status,
          patched: handle.patched,
          mode: handle.mode,
          notice: () => bus.get(),
          active: () => handle.active,
          ownSetItem: () => Object.prototype.hasOwnProperty.call(window.localStorage, "setItem")
        };
      }
    } catch (error) {
    }
    const dispose = () => {
      try {
        bus.dispose();
      } catch (error) {
        console.error("[dsh-toolbox] draft notice dispose failed", error);
      }
      try {
        handle.dispose();
      } catch (error) {
        console.error("[dsh-toolbox] draft guard dispose failed", error);
      }
      try {
        if (typeof window !== "undefined" && window.__DSH_TOOLBOX_DRAFT__) delete window.__DSH_TOOLBOX_DRAFT__;
      } catch (error) {
      }
    };
    env.track(dispose);
    return dispose;
  }

  // src/client/features/panel-menu.js
  var NS3 = "dsh-panel-menu";
  var TRIGGER_SLOT = "sidebar.footer.action";
  var OVERLAY_SLOT2 = "shell.overlay";
  var TRIGGER_ID = "panel-menu.trigger";
  var MENU_ID2 = "panel-menu.menu";
  var PANEL_SLOT = "sidebar.panellist";
  var NAV_SELECTOR = '[class*="panelList"]';
  var PROXY_ENTRIES = [
    {
      selector: '[class~="dsham-entry"]',
      labelKey: "archive",
      order: 20,
      activeAttr: "data-active"
    }
  ];
  var LABEL_OVERRIDES = {
    plugins: "officialPlugins"
  };
  var ZH3 = {
    trigger: "全部面板",
    empty: "没有可显示的面板",
    failed: "打开失败",
    officialPlugins: "官方插件管理",
    archive: "历史归档"
  };
  var EN3 = {
    trigger: "All panels",
    empty: "Nothing to show",
    failed: "Could not open",
    officialPlugins: "Official plugin manager",
    archive: "Archive"
  };
  var MENU_WIDTH = 236;
  var MENU_MAX_HEIGHT = 320;
  var FALLBACK_FONT = '13px/18px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  var HIDE_CSS = [
    "/* dsh-panel-menu — the panel rows are reachable from the popover menu. */",
    NAV_SELECTOR + "{display:none !important}"
  ].concat(PROXY_ENTRIES.map((entry) => entry.selector + "{display:none !important}")).join("\n");
  var listeners = /* @__PURE__ */ new Set();
  var menuState = { open: false, anchor: null, items: [], error: null };
  function setMenu(patch) {
    menuState = Object.assign({}, menuState, patch);
    listeners.forEach((notify) => {
      try {
        notify();
      } catch (err) {
        console.error("[dsh-panel-menu] menu listener failed", err);
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
  function all(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (err) {
      console.error("[dsh-panel-menu] selector failed", selector, err);
      return [];
    }
  }
  function labelOf(label, fallback) {
    try {
      if (typeof label === "function") {
        const value = label();
        if (typeof value === "string" && value) return value;
      }
    } catch (err) {
      console.error("[dsh-panel-menu] label thunk failed", err);
    }
    return typeof label === "string" && label ? label : fallback;
  }
  function collectPanels(ctx, t) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    try {
      const slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : null);
      const ledger = slots && typeof slots.entriesOfSlot === "function" ? slots.entriesOfSlot(PANEL_SLOT) : [];
      (ledger || []).forEach((entry, index) => {
        const options = entry && entry.options || {};
        const id = options.id;
        if (!id || id === TRIGGER_ID || seen.has(id)) return;
        seen.add(id);
        items.push({
          key: "slot:" + id,
          label: LABEL_OVERRIDES[id] ? t(LABEL_OVERRIDES[id]) : labelOf(options.label, id),
          order: typeof options.order === "number" ? options.order : index,
          panelId: id,
          run() {
            let layout = null;
            try {
              layout = ctx.layout;
            } catch (err) {
              layout = null;
            }
            if (!layout && typeof ctx.get === "function") layout = ctx.get("layout");
            if (!layout || typeof layout.selectPanel !== "function") {
              throw new Error("layout.selectPanel is unavailable");
            }
            layout.selectPanel(id);
          }
        });
      });
    } catch (err) {
      console.error("[dsh-panel-menu] could not read the panel ledger", err);
    }
    PROXY_ENTRIES.forEach((spec, index) => {
      const nodes = all(spec.selector);
      if (nodes.length === 0) return;
      const domLabel = nodes[0].getAttribute ? nodes[0].getAttribute("aria-label") : null;
      items.push({
        key: "dom:" + index,
        label: domLabel && domLabel.trim() || t(spec.labelKey),
        order: typeof spec.order === "number" ? spec.order : 100 + index,
        isActive: () => all(spec.selector).some(
          (node) => node.hasAttribute(spec.activeAttr || "data-active") || node.getAttribute("aria-current") === "page"
        ),
        run() {
          const target = all(spec.selector)[0];
          if (!target) throw new Error("the injected row is gone");
          target.click();
        }
      });
    });
    return items.sort((a, b) => a.order - b.order);
  }
  function isItemActive(item, activePanelId) {
    if (typeof item.isActive === "function") {
      try {
        return item.isActive() === true;
      } catch (err) {
        console.error("[dsh-panel-menu] active-state probe failed", item.key, err);
        return false;
      }
    }
    return item.panelId === activePanelId;
  }
  function moreGlyph(size) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "currentColor",
        "aria-hidden": true,
        style: { display: "block", flex: "0 0 auto" }
      },
      h("circle", { key: "a", cx: 3.2, cy: 8, r: 1.5 }),
      h("circle", { key: "b", cx: 8, cy: 8, r: 1.5 }),
      h("circle", { key: "c", cx: 12.8, cy: 8, r: 1.5 })
    );
  }
  function checkGlyph(size) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        style: { display: "block", flex: "0 0 auto" }
      },
      h("path", { d: "M3 8.5 6.2 11.7 13 5" })
    );
  }
  function applyBody(ctx) {
    ctx.effect(() => ctx.locale.register(NS3, "zh", ZH3), "panel-menu: zh dictionary");
    ctx.effect(() => ctx.locale.register(NS3, "en", EN3), "panel-menu: en dictionary");
    const t = ctx.locale.bind(NS3);
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
          console.error("[dsh-panel-menu] could not measure the trigger", err);
        }
        setMenu({ open: true, anchor, items: collectPanels(ctx, t), error: null });
      }
      return h(
        fragment(),
        null,
        /* The stylesheet rides the always-mounted trigger, so it is
         * present whether or not the menu is open. */
        h("style", { key: "stylesheet" }, HIDE_CSS),
        h(
          "button",
          {
            key: "trigger",
            type: "button",
            className: "dshpm-trigger",
            "aria-haspopup": "true",
            "aria-expanded": snapshot.open ? "true" : "false",
            "aria-label": t("trigger"),
            title: t("trigger"),
            onClick,
            style: {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: wide ? "flex-start" : "center",
              gap: "6px",
              flex: wide ? "1 1 auto" : "0 0 auto",
              width: wide ? "auto" : size + "px",
              height: size + "px",
              padding: wide ? "0 9px" : "0",
              margin: wide ? "0 2px" : "0",
              border: "0",
              borderRadius: "var(--dsw-radius-md, 8px)",
              background: snapshot.open ? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))" : "transparent",
              color: "var(--dsw-alias-label-secondary, #6b7280)",
              font: "inherit",
              fontSize: "13px",
              lineHeight: "18px",
              whiteSpace: "nowrap",
              cursor: "pointer"
            }
          },
          moreGlyph(wide ? 16 : 18),
          wide ? h("span", { key: "label" }, t("trigger")) : null
        )
      );
    }
    function PanelMenuOverlay(props) {
      const snapshot = useMenuState();
      const [hover, setHover] = useState(null);
      const readPanelInfo = props.usePanelInfo;
      const activePanelId = typeof readPanelInfo === "function" ? readPanelInfo((info) => info ? info.activePanelId : null) : null;
      useEffect(() => {
        if (!snapshot.open) return void 0;
        function onKey(event) {
          if (event.key === "Escape") setMenu({ open: false });
        }
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
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
          "button",
          {
            key: item.key,
            type: "button",
            role: "menuitemradio",
            "aria-checked": active ? "true" : "false",
            title: item.label,
            onMouseEnter: () => setHover(item.key),
            onMouseLeave: () => setHover((current) => current === item.key ? null : current),
            onClick: () => {
              try {
                item.run();
                setMenu({ open: false, error: null });
              } catch (err) {
                console.error("[dsh-panel-menu] could not open", item.key, err);
                const detail = err && err.message ? err.message : String(err);
                setMenu({ error: t("failed") + " — " + detail });
              }
            },
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              padding: "7px 9px",
              border: "0",
              borderRadius: "8px",
              background: hovered ? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))" : "transparent",
              color: "var(--dsw-alias-label-primary, #1f2329)",
              font: "inherit",
              textAlign: "left",
              cursor: "pointer"
            }
          },
          h(
            "span",
            {
              key: "label",
              style: {
                flex: "1 1 auto",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }
            },
            item.label
          ),
          active ? checkGlyph(14) : null
        );
      });
      return h(
        "div",
        {
          key: "backdrop",
          /* The overlay layer is click-through; this entry opts back in so
           * a click anywhere closes the menu. */
          style: { position: "fixed", inset: "0", zIndex: 9998, pointerEvents: "auto" },
          onMouseDown: () => setMenu({ open: false }),
          onContextMenu: (event) => {
            event.preventDefault();
            setMenu({ open: false });
          }
        },
        h(
          "div",
          {
            role: "menu",
            "aria-label": t("trigger"),
            onMouseDown: (event) => event.stopPropagation(),
            style: {
              position: "fixed",
              left: left + "px",
              bottom: bottom + "px",
              width: MENU_WIDTH + "px",
              maxHeight: MENU_MAX_HEIGHT + "px",
              overflowY: "auto",
              padding: "6px",
              borderRadius: "12px",
              background: "var(--dsw-alias-bg-overlay, #ffffff)",
              border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10))",
              boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
              color: "var(--dsw-alias-label-primary, #1f2329)",
              font: FALLBACK_FONT,
              userSelect: "none"
            }
          },
          /* No heading row: the trigger already says "All panels", and the
           * card opens straight onto the list. */
          snapshot.items.length === 0 ? h(
            "div",
            {
              key: "empty",
              style: {
                padding: "6px 8px",
                color: "var(--dsw-alias-label-secondary, #6b7280)"
              }
            },
            t("empty")
          ) : rows,
          snapshot.error ? h(
            "div",
            {
              key: "error",
              style: {
                margin: "4px 2px 0",
                padding: "6px 8px",
                borderRadius: "8px",
                background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))",
                color: "var(--dsw-alias-state-error-primary, #d33)",
                fontSize: "12px",
                wordBreak: "break-word"
              }
            },
            snapshot.error
          ) : null
        )
      );
    }
    ctx.effect(
      () => ctx.slots.inject(
        TRIGGER_SLOT,
        () => ctx.slots.register(
          { name: TRIGGER_SLOT, id: TRIGGER_ID, order: 60 },
          PanelMenuTrigger
        )
      ),
      "panel-menu: sidebar trigger"
    );
    ctx.effect(
      () => ctx.slots.inject(
        OVERLAY_SLOT2,
        () => ctx.slots.register({ name: OVERLAY_SLOT2, id: MENU_ID2, order: 900 }, PanelMenuOverlay)
      ),
      "panel-menu: panel popover"
    );
  }
  function resetMenuState() {
    try {
      setMenu({ open: false, anchor: null, items: [], error: null });
    } catch (error) {
    }
  }
  function mount3(ctx, env) {
    resetMenuState();
    const scoped = new Proxy(ctx, {
      get(target, prop) {
        if (prop === "effect") {
          return (fn, label) => env.track(target.effect(fn, label));
        }
        if (prop === "layout") {
          try {
            const declared = Reflect.get(target, prop);
            if (declared) return declared;
          } catch (error) {
          }
          return typeof target.get === "function" ? target.get("layout") : void 0;
        }
        return Reflect.get(target, prop);
      }
    });
    applyBody(scoped);
    const dispose = () => resetMenuState();
    env.track(dispose);
    return dispose;
  }

  // src/client/features/archive-client.js
  var TOKEN_PATH = "/api/archive-manager/token";
  var DELETE_PATH = "/api/archive-manager/delete";
  var LIST_PATH = "/api/archive-manager/list";
  var UNARCHIVE_PATH = "/api/archive-manager/unarchive";
  var CSRF_HEADER = "x-dsh-toolbox";
  var TOKEN_HEADER = "x-dsh-toolbox-token";
  var MIN_TOKEN_LENGTH = 32;
  function createArchiveClient({ fetchImpl, base = () => "" } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("dsh-toolbox: createArchiveClient needs a fetch");
    let token = null;
    let inFlight = null;
    let disposed = false;
    let refreshes = 0;
    function requireAlive() {
      if (disposed) {
        const error = new Error("archive client disposed");
        error.code = "disposed";
        throw error;
      }
    }
    function refresh(force = false) {
      requireAlive();
      if (!force && typeof token === "string") return Promise.resolve(token);
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        try {
          const response = await fetchImpl(base() + TOKEN_PATH, {
            method: "GET",
            headers: { [CSRF_HEADER]: "1" },
            credentials: "same-origin",
            cache: "no-store"
          });
          if (!response || response.ok !== true) throw new Error("token-unavailable");
          const body = await response.json();
          if (!body || typeof body.token !== "string" || body.token.length < MIN_TOKEN_LENGTH) {
            throw new Error("token-unavailable");
          }
          token = body.token;
          refreshes += 1;
          return token;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    }
    function post(sessionId, credential) {
      return fetchImpl(base() + DELETE_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: "1",
          [TOKEN_HEADER]: credential
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ sessionId })
      });
    }
    async function authorized(path, init) {
      let credential;
      try {
        credential = token !== null ? token : await refresh();
      } catch (error) {
        return { status: 0, reason: "token-unavailable" };
      }
      const send = (value) => fetchImpl(base() + path, {
        ...init,
        headers: { ...init.headers ?? {}, [CSRF_HEADER]: "1", [TOKEN_HEADER]: value },
        credentials: "same-origin",
        cache: "no-store"
      });
      let response;
      try {
        response = await send(credential);
      } catch (error) {
        return { status: 0, reason: "network-error" };
      }
      if (response.status === 401) {
        token = null;
        let fresh;
        try {
          fresh = await refresh(true);
        } catch (error) {
          return { status: 401, reason: "refresh-required" };
        }
        try {
          response = await send(fresh);
        } catch (error) {
          return { status: 0, reason: "network-error" };
        }
        if (response.status === 401) {
          token = null;
          return { status: 401, reason: "refresh-required" };
        }
      }
      return { status: response.status, response };
    }
    async function readJson(response) {
      try {
        return await response.json();
      } catch (error) {
        return void 0;
      }
    }
    return {
      /** Delete one archived session. Never throws; every failure is a code. */
      async delete(sessionId) {
        if (disposed) return { ok: false, status: 0, reason: "disposed" };
        let credential;
        try {
          credential = token !== null ? token : await refresh();
        } catch (error) {
          return { ok: false, status: 0, reason: "token-unavailable" };
        }
        let response;
        try {
          response = await post(sessionId, credential);
        } catch (error) {
          return { ok: false, status: 0, reason: "network-error" };
        }
        if (response.status === 401) {
          token = null;
          let fresh;
          try {
            fresh = await refresh(true);
          } catch (error) {
            return { ok: false, status: 401, reason: "refresh-required" };
          }
          try {
            response = await post(sessionId, fresh);
          } catch (error) {
            return { ok: false, status: 0, reason: "network-error" };
          }
          if (response.status === 401) {
            token = null;
            return { ok: false, status: 401, reason: "refresh-required" };
          }
        }
        const body = await readJson(response);
        return {
          ok: response.status === 200 && body?.ok !== false,
          status: response.status,
          reason: body?.reason ?? (response.ok ? void 0 : "request-failed")
        };
      },
      /** GET the archived rows. */
      async list() {
        if (disposed) return { ok: false, rows: [], reason: "disposed" };
        const result = await authorized(LIST_PATH, { method: "GET" });
        if (result.response === void 0) return { ok: false, rows: [], reason: result.reason };
        if (result.status === 404) return { ok: false, rows: [], reason: "http-404" };
        if (result.status === 503) return { ok: false, rows: [], reason: "http-503" };
        const body = await readJson(result.response);
        if (!result.response.ok || body?.ok === false) {
          return { ok: false, rows: [], reason: body?.reason ?? "request-failed" };
        }
        return { ok: true, rows: Array.isArray(body?.rows) ? body.rows : [] };
      },
      /** Undo the archive flag. */
      async unarchive(sessionId) {
        if (disposed) return { ok: false, status: 0, reason: "disposed" };
        const result = await authorized(UNARCHIVE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId })
        });
        if (result.response === void 0) return { ok: false, status: 0, reason: result.reason };
        if (result.status === 404) return { ok: false, status: 404, reason: "http-404" };
        if (result.status === 503) return { ok: false, status: 503, reason: "http-503" };
        const body = await readJson(result.response);
        if (!result.response.ok) return { ok: false, status: result.status, reason: body?.reason ?? "request-failed" };
        return { ok: true, status: result.status };
      },
      /**
       * id -> title, from the loopback inventory the session-archive plugin serves.
       * Read-only and same-origin; any failure degrades to an empty map so the panel
       * still works.
       */
      async titleMap() {
        try {
          const response = await fetchImpl("/api/dsh-session-archive/inventory", { method: "GET", credentials: "same-origin" });
          if (!response || response.ok !== true) return {};
          const body = await response.json();
          const out = {};
          for (const row of Array.isArray(body?.rows) ? body.rows : []) {
            if (row && typeof row.id === "string") out[row.id] = typeof row.title === "string" ? row.title : "";
          }
          return out;
        } catch (error) {
          return {};
        }
      },
      /** Ask for a token without deleting anything (used on panel open). */
      refresh,
      /** Diagnostics only: the token never leaves this module otherwise. */
      stats: () => ({ hasToken: typeof token === "string", refreshes, inFlight: inFlight !== null }),
      /** Drop the memory token and any in-flight refresh. */
      dispose() {
        disposed = true;
        token = null;
        inFlight = null;
      }
    };
  }

  // src/client/features/archive-panel-model.js
  var REASON_TEXT = Object.freeze({
    "refresh-required": "需要刷新页面（凭证已失效）",
    "token-unavailable": "拿不到凭证：请确认第 7 个开关已开启，然后刷新页面",
    "network-error": "网络错误：宿主可能正在重启",
    disposed: "面板已卸载，请刷新页面",
    "archive-session-adapter-unavailable": "宿主还没接上会话服务，归档接口暂不可用",
    live: "这个会话正在使用中，不能删除",
    "not-archived": "这个会话已经不在归档列表里了",
    "trash-full": "回收站已满：请先恢复或清理，再删除",
    "journal-corrupt": "回收站状态文件损坏，已停止删除（请人工检查）",
    "cross-device": "回收站和会话不在同一个磁盘，无法原子移动",
    "unsafe-trash-root": "回收站位置不安全，已拒绝执行",
    "claim-failed": "删除声明写入失败",
    "http-404": "接口没有注册：请打开第 7 个开关",
    "http-503": "服务未就绪"
  });
  function createArchivePanel({ client, isEnabled }) {
    let rows = [];
    let titles = {};
    let pending = null;
    let state = "idle";
    let message = "";
    const enabled = () => {
      try {
        return isEnabled() === true;
      } catch (error) {
        return false;
      }
    };
    function phrase(reason) {
      return REASON_TEXT[reason] ?? "操作失败：" + String(reason ?? "unknown");
    }
    async function refresh() {
      if (!enabled()) {
        state = "disabled";
        message = "归档 HTTP 接口未启用";
        rows = [];
        return { ok: false, reason: "disabled" };
      }
      state = "loading";
      const result = await client.list();
      if (result.ok) {
        rows = result.rows;
        titles = typeof client.titleMap === "function" ? await client.titleMap() : {};
        state = "ready";
        message = "";
        return { ok: true };
      }
      state = "error";
      message = phrase(result.reason);
      return { ok: false, reason: result.reason };
    }
    async function act(kind, id) {
      if (!enabled()) return { ok: false, reason: "disabled" };
      const result = kind === "delete" ? await client.delete(id) : await client.unarchive(id);
      if (!result.ok) {
        message = phrase(result.reason);
        return result;
      }
      message = "";
      await refresh();
      return result;
    }
    return {
      refresh,
      /** 点「删除」：只提问，不动数据。 */
      askRemove(id) {
        pending = id;
        message = "";
      },
      /** 确认移入回收箱。 */
      async confirmRemove() {
        const id = pending;
        pending = null;
        if (id === null) return { ok: false, reason: "nothing-to-remove" };
        return act("delete", id);
      },
      cancelRemove() {
        pending = null;
      },
      unarchive: (id) => act("unarchive", id),
      remove: (id) => act("delete", id),
      /** What the container draws. Pure data: no DOM, no observers, no timers. */
      view() {
        return Object.freeze({
          state,
          message,
          rows: rows.map(
            (row) => Object.freeze({
              id: row.id,
              phase: row.phase,
              title: titles[row.id] || "",
              // A title is what a human recognises; the id tail is only a fallback.
              label: titles[row.id] || "会话 " + String(row.id).slice(-8)
            })
          ),
          canDelete: enabled(),
          pending
        });
      },
      dispose() {
        client.dispose();
        rows = [];
        state = "idle";
        message = "";
      }
    };
  }

  // src/client/switches.js
  var CACHE_KEY = "dsh-toolbox.switches.v1";
  var ROW_ID = "toolbox";
  var PACKAGE = "dsh-toolbox";
  var RETRY_MS = 150;
  var MAX_RETRIES = 40;
  function formService(ctx) {
    try {
      return ctx && typeof ctx.get === "function" && ctx.get("configForms") || void 0;
    } catch (error) {
      return void 0;
    }
  }
  function candidateIds() {
    return [ROW_ID, PACKAGE + "#" + ROW_ID, PACKAGE];
  }
  function pickForm(ctx) {
    const forms = formService(ctx);
    if (!forms || typeof forms.get !== "function") return void 0;
    let served = [];
    try {
      const snapshot = forms.describe().getSnapshot();
      served = (snapshot && snapshot.view && snapshot.view.namespaces || []).map((entry) => entry.ns);
    } catch (error) {
      served = [];
    }
    const entryId = candidateIds().find((candidate) => served.includes(candidate)) ?? ROW_ID;
    try {
      const form = forms.get(entryId);
      return form ? { form, entryId } : void 0;
    } catch (error) {
      return void 0;
    }
  }
  function valuesOf(form) {
    try {
      if (!form || typeof form.getSnapshot !== "function") return void 0;
      const snapshot = form.getSnapshot();
      const value = snapshot && snapshot.value;
      return value && typeof value === "object" ? Object.assign({}, value) : void 0;
    } catch (error) {
      return void 0;
    }
  }
  function readSwitches(ctx, options = {}) {
    const { isCancelled = () => false } = options;
    return new Promise((resolve) => {
      let tries = 0;
      const attempt = () => {
        if (isCancelled()) {
          resolve({});
          return;
        }
        const picked = pickForm(ctx);
        const values = picked ? valuesOf(picked.form) : void 0;
        if (values) {
          storeSwitches(values);
          resolve(values);
          return;
        }
        tries += 1;
        if (tries >= MAX_RETRIES) {
          resolve({});
          return;
        }
        setTimeout(attempt, RETRY_MS);
      };
      attempt();
    });
  }
  function watchSwitches(ctx, callback, options = {}) {
    const { isCancelled = () => false, retryMs = RETRY_MS, maxRetries = MAX_RETRIES } = options;
    let stopped = false;
    let unsubscribe;
    let timer;
    let attempts = 0;
    const stop = () => {
      stopped = true;
      if (timer !== void 0) clearTimeout(timer);
      timer = void 0;
      if (typeof unsubscribe === "function") {
        try {
          unsubscribe();
        } catch (error) {
        }
        unsubscribe = void 0;
      }
    };
    const bind = () => {
      if (stopped || isCancelled()) return;
      const picked = pickForm(ctx);
      if (!picked || typeof picked.form.subscribe !== "function") {
        attempts += 1;
        if (attempts >= maxRetries) {
          console.warn(
            "[dsh-toolbox] configForms never appeared after " + maxRetries + " attempts; live switch updates are disabled until the page reloads"
          );
          return;
        }
        timer = setTimeout(bind, retryMs);
        return;
      }
      try {
        unsubscribe = picked.form.subscribe(() => {
          const values = valuesOf(picked.form);
          if (!values) return;
          storeSwitches(values);
          try {
            callback(values);
          } catch (error) {
            console.error("[dsh-toolbox] switch callback failed", error);
          }
        });
      } catch (error) {
        attempts += 1;
        if (attempts < maxRetries) timer = setTimeout(bind, retryMs);
      }
    };
    bind();
    return stop;
  }
  function cacheSwitches() {
    try {
      const storage = typeof window !== "undefined" ? window.localStorage : void 0;
      if (!storage) return {};
      const raw = storage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.package !== PACKAGE || parsed.rowId !== ROW_ID) return {};
      return parsed.values && typeof parsed.values === "object" ? parsed.values : {};
    } catch (error) {
      return {};
    }
  }
  function storeSwitches(values) {
    try {
      const storage = typeof window !== "undefined" ? window.localStorage : void 0;
      if (!storage) return;
      storage.setItem(CACHE_KEY, JSON.stringify({ package: PACKAGE, rowId: ROW_ID, values: values || {} }));
    } catch (error) {
    }
  }

  // src/client/features/archive-panel.js
  var ARCHIVE_CSS = `
.dsh-toolbox-archive{display:flex;flex-direction:column;height:100%;min-height:0;padding:16px 18px;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-toolbox-archive header{flex:none;font-size:15px;font-weight:650;display:flex;align-items:baseline;gap:8px}
.dsh-toolbox-archive-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);opacity:.75}
.dsh-toolbox-archive-note{flex:none;margin:0;color:var(--dsw-alias-label-secondary);opacity:.85;font-size:12px}
.dsh-toolbox-archive-empty{flex:none;margin:0;padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);opacity:.7}
.dsh-toolbox-archive ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}
.dsh-toolbox-archive li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;transition:background .15s ease}
.dsh-toolbox-archive li:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-toolbox-archive-title{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-toolbox-archive-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsh-toolbox-archive-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);opacity:.6;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-toolbox-archive button{flex:none;font-family:inherit;font-size:12px;line-height:1;padding:5px 11px;border-radius:7px;cursor:pointer;border:1px solid transparent;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:background .15s ease,color .15s ease,border-color .15s ease}
.dsh-toolbox-archive button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-toolbox-archive button:disabled{opacity:.5;cursor:default}
.dsh-toolbox-archive button.danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-toolbox-archive button.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 15%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 32%,transparent)}
`;
  function ensureStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById("dsh-toolbox-archive-css") !== null) return;
    const style = document.createElement("style");
    style.id = "dsh-toolbox-archive-css";
    style.dataset.dshToolbox = "archive";
    style.textContent = ARCHIVE_CSS;
    document.head.appendChild(style);
  }
  var PANEL_ID = "dsh-toolbox#archive";
  var MAIN_SLOT = "main";
  var PANEL_SLOT2 = "sidebar.panellist";
  var liveEnabled = null;
  function archiveApiEnabled() {
    try {
      if (liveEnabled !== null) return liveEnabled;
      return cacheSwitches()?.archiveHttpApi === true;
    } catch (error) {
      return false;
    }
  }
  function mount4(ctx, env) {
    if (!ctx.slots || typeof ctx.slots.register !== "function" || typeof ctx.slots.inject !== "function") {
      throw new Error("dsh-toolbox: the slots service is unavailable");
    }
    env.track(
      watchSwitches(ctx, (values) => {
        liveEnabled = values?.archiveHttpApi === true;
        console.info("[dsh-toolbox] switch values =", values);
        console.info("[dsh-toolbox] archiveHttpApi =", liveEnabled);
      }, {})
    );
    ensureStyles();
    const client = createArchiveClient({ fetchImpl: (url, init) => fetch(url, init) });
    const panel = createArchivePanel({ client, isEnabled: archiveApiEnabled });
    function ArchiveView() {
      const [view, setView] = useState(() => panel.view());
      const [busy, setBusy] = useState(false);
      const sync = () => setView(panel.view());
      useEffect(() => {
        let live2 = true;
        void panel.refresh().then(() => {
          if (live2) sync();
        });
        return () => {
          live2 = false;
        };
      }, []);
      const run = (action) => async () => {
        setBusy(true);
        await action();
        if (live()) sync();
        setBusy(false);
      };
      const live = () => true;
      return h("div", { class: "dsh-toolbox-archive" }, [
        h("header", null, [
          h("strong", null, "历史归档"),
          h("span", { class: "dsh-toolbox-archive-count" }, view.rows.length === 0 ? "共 0 条" : `共 ${view.rows.length} 条`)
        ]),
        view.message ? h("p", { class: "dsh-toolbox-archive-note" }, view.message) : null,
        view.pending ? h("div", { class: "dsh-toolbox-archive-confirm" }, [
          h("span", null, "移入回收箱？可以随时恢复。"),
          h(
            "button",
            {
              type: "button",
              style: { color: "#b3261e", borderColor: "#b3261e", fontWeight: "600" },
              onClick: run(() => panel.confirmRemove())
            },
            "入回收箱"
          ),
          h("button", { type: "button", onClick: () => {
            panel.cancelRemove();
            sync();
          } }, "取消")
        ]) : null,
        view.rows.length === 0 && !view.message ? h("p", { class: "dsh-toolbox-archive-empty" }, "没有归档会话") : null,
        h(
          "ul",
          null,
          view.rows.map(
            (row) => h("li", { key: row.id }, [
              h("span", { class: "dsh-toolbox-archive-title" }, [
                h("strong", null, row.label),
                h("div", { class: "dsh-toolbox-archive-id" }, row.id)
              ]),
              h("button", { type: "button", disabled: busy || !view.canDelete, onClick: run(() => panel.unarchive(row.id)) }, "恢复"),
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  disabled: busy || !view.canDelete,
                  onClick: () => {
                    const name = row.label || row.id;
                    let yes = false;
                    try {
                      yes = window.confirm(`确定要彻底删除这个会话吗？

「${name}」

删除后无法恢复。`);
                    } catch (error) {
                      yes = false;
                    }
                    if (!yes) return;
                    run(() => panel.remove(row.id))();
                  }
                },
                "删除"
              )
            ])
          )
        )
      ]);
    }
    function SidebarRow() {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          style: { display: "block" }
        },
        [
          h("path", { key: "box", d: "M2.5 5.5h11M4 5.5V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.5M5.5 5.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5M6 9h4" })
        ]
      );
    }
    const mainReg = ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, ArchiveView);
    console.info("[dsh-toolbox] registered main panel, disposer =", typeof mainReg);
    if (typeof mainReg === "function") env.track(mainReg);
    const rowReg = ctx.slots.inject(PANEL_SLOT2, () => ctx.slots.register({ name: PANEL_SLOT2, id: PANEL_ID, order: 200, label: "历史归档" }, SidebarRow));
    console.info("[dsh-toolbox] registered panellist row, disposer =", typeof rowReg);
    if (typeof rowReg === "function") env.track(rowReg);
    const readEntries = () => {
      try {
        const list = typeof ctx.slots.entriesOfSlot === "function" ? ctx.slots.entriesOfSlot(PANEL_SLOT2) : void 0;
        if (!Array.isArray(list)) return "entriesOfSlot unavailable";
        return list.map((entry) => entry && entry.options ? entry.options.id : entry && (entry.id ?? entry.key));
      } catch (error) {
        return "threw: " + String(error && error.message);
      }
    };
    console.info("[dsh-toolbox] archive panel mounted; panellist entries =", readEntries());
    if (typeof window !== "undefined") window.__DSH_TOOLBOX_ARCHIVE__ = {
      mounted: true,
      panelId: PANEL_ID,
      mainSlot: MAIN_SLOT,
      listSlot: PANEL_SLOT2,
      entries: readEntries,
      open: () => {
        const layout = (typeof ctx.get === "function" ? ctx.get("layout") : void 0) || ctx.layout;
        if (!layout || typeof layout.selectPanel !== "function") return "no layout service";
        try {
          layout.selectPanel(PANEL_ID);
          return "opened";
        } catch (error) {
          return "threw: " + String(error && error.message);
        }
      },
      apiEnabled: () => archiveApiEnabled()
    };
    return () => {
      if (typeof window !== "undefined" && window.__DSH_TOOLBOX_ARCHIVE__) delete window.__DSH_TOOLBOX_ARCHIVE__;
      panel.dispose();
    };
  }

  // src/client/features.js
  function createFeatureProbe() {
    const mounts = /* @__PURE__ */ new Map();
    return {
      bump(id) {
        mounts.set(id, (mounts.get(id) ?? 0) + 1);
        return mounts.get(id);
      },
      count(id) {
        return mounts.get(id) ?? 0;
      }
    };
  }
  function createFeatures(probe, host) {
    const track = (id, env) => {
      env.track(host.addListener(id, () => {
      }));
    };
    return defineFeatures([
      {
        id: "quote-reply",
        configKey: "quoteReply",
        title: "划词引用",
        reversible: true,
        mount(ctx, env) {
          probe.bump("quote-reply");
          return mount(ctx, env);
        }
      },
      {
        id: "panel-menu",
        configKey: "panelMenu",
        title: "面板收纳",
        reversible: true,
        mount(ctx, env) {
          probe.bump("panel-menu");
          return mount3(ctx, env);
        }
      },
      {
        id: "draft-saver",
        configKey: "draftSaver",
        title: "草稿保险箱",
        reversible: false,
        mount(ctx, env) {
          probe.bump("draft-saver");
          return mount2(ctx, env);
        }
      },
      {
        id: "archive-panel",
        configKey: "archivePanel",
        title: "历史归档",
        reversible: false,
        mount(ctx, env) {
          probe.bump("archive-panel");
          return mount4(ctx, env);
        }
      },
      {
        id: "plugin-zh",
        configKey: "pluginZh",
        title: "插件汉化",
        reversible: false,
        mount(ctx, env) {
          probe.bump("plugin-zh");
          track("plugin-zh", env);
        }
      }
    ]);
  }

  // src/shared/switches.js
  var SWITCHES = Object.freeze([
    { key: "quoteReply", label: "划词引用", hint: "划选对话文字后浮出「引用 / 复制」" },
    { key: "draftSaver", label: "草稿保险箱", hint: "没发送的内容不会丢" },
    { key: "panelMenu", label: "面板收纳", hint: "把侧栏的面板入口收进一个菜单" },
    { key: "archivePanel", label: "历史归档", hint: "列归档会话、一键恢复、删除" },
    { key: "pluginZh", label: "插件说明汉化", hint: "插件管理页的英文简介换成中文" },
    { key: "sessionSearch", label: "会话搜索（宿主工具）", hint: "给 AI 一个 session_search 工具；不影响侧栏搜索" },
    { key: "archiveHttpApi", label: "归档 HTTP 接口（实验性）", hint: "给页面一个带令牌的删除通道；默认关闭", hostOnly: true }
  ]);
  var SWITCH_KEYS = Object.freeze(SWITCHES.map((entry) => entry.key));
  var CLIENT_SWITCH_KEYS = Object.freeze(
    SWITCHES.filter((entry) => entry.hostOnly !== true && entry.key !== "sessionSearch").map((entry) => entry.key)
  );

  // src/client/form.js
  var SLOT = "plugins.row.config";
  var SLOT_KEY = "dsh-toolbox#toolbox";
  var RETRY_MS2 = 150;
  var MAX_RETRIES2 = 40;
  function resolveValue(values, overlay, key) {
    if (overlay && Object.prototype.hasOwnProperty.call(overlay, key)) return overlay[key] === true;
    return !!(values && values[key] === true);
  }
  function isSwitchDisabled(ready, pending, key) {
    if (!ready) return true;
    return !!(pending && pending[key] === true);
  }
  function pruneOverlay(overlay, values) {
    if (!overlay) return {};
    if (!values) return overlay;
    const out = {};
    for (const key of Object.keys(overlay)) {
      if (values[key] !== overlay[key]) out[key] = overlay[key];
    }
    return out;
  }
  function valuesFromPropsForm(form) {
    try {
      if (!form || typeof form !== "object") return void 0;
      const state = form.state;
      if (!state) return void 0;
      if (typeof state.getSnapshot === "function") {
        const snapshot = state.getSnapshot();
        const value2 = snapshot && snapshot.value;
        if (value2 && typeof value2 === "object") return Object.assign({}, value2);
      }
      const value = state.value;
      if (value && typeof value === "object") return Object.assign({}, value);
      return void 0;
    } catch (error) {
      return void 0;
    }
  }
  function revisionOf(form) {
    try {
      const state = form && form.state;
      if (!state) return void 0;
      if (typeof state.getSnapshot === "function") {
        const snapshot = state.getSnapshot();
        return snapshot && snapshot.revision;
      }
      if (typeof state === "object" && "revision" in state) return state.revision;
    } catch (error) {
    }
    return void 0;
  }
  function writeSwitch(props, ctx, key, next) {
    const picked = pickForm(ctx);
    if (picked && picked.form && typeof picked.form.set === "function") {
      return picked.form.set(key, next);
    }
    const form = props && props.form;
    if (form && typeof form.mutate === "function") {
      return form.mutate([{ op: "set", path: [key], value: next }], revisionOf(form));
    }
    throw new Error("no writable settings form");
  }
  function createSettingsCard(ctx) {
    return function SettingsCard(props) {
      const [state, setState] = useState({ status: "loading", values: void 0, source: "" });
      const [overlay, setOverlay] = useState({});
      const [pending, setPending] = useState({});
      const [error, setError] = useState("");
      useEffect(() => {
        let alive = true;
        let tries = 0;
        let unsubscribe;
        let timer;
        const publish = (values2, source) => {
          if (!alive || !values2) return false;
          storeSwitches(values2);
          setState({ status: "ready", values: values2, source });
          setOverlay((previous) => pruneOverlay(previous, values2));
          return true;
        };
        const attempt = () => {
          if (!alive) return;
          const fromProps = valuesFromPropsForm(props.form);
          if (fromProps && publish(fromProps, "props.form")) return;
          const picked = pickForm(ctx);
          const values2 = picked ? valuesOf(picked.form) : void 0;
          if (values2 && publish(values2, "configForms")) {
            try {
              unsubscribe = picked.form.subscribe(() => {
                const next = valuesOf(picked.form);
                if (next) publish(next, "configForms");
              });
            } catch (subscribeError) {
            }
            return;
          }
          tries += 1;
          if (tries < MAX_RETRIES2) timer = setTimeout(attempt, RETRY_MS2);
          else if (alive) setState({ status: "unavailable", values: void 0, source: "none" });
        };
        attempt();
        return () => {
          alive = false;
          if (timer !== void 0) clearTimeout(timer);
          if (typeof unsubscribe === "function") {
            try {
              unsubscribe();
            } catch (unsubscribeError) {
            }
          }
        };
      }, [props.form]);
      const toggle = useCallback(
        (key, next) => {
          setOverlay((previous) => Object.assign({}, previous, { [key]: next }));
          setPending((previous) => Object.assign({}, previous, { [key]: true }));
          setError("");
          const revert = () => {
            setOverlay((previous) => {
              const copy = Object.assign({}, previous);
              delete copy[key];
              return copy;
            });
          };
          try {
            Promise.resolve(writeSwitch(props, ctx, key, next)).then((ok) => {
              if (ok === false) {
                revert();
                setError("服务拒绝了这次写入，开关已还原");
              }
            }).catch((writeError) => {
              revert();
              setError("写入失败：" + String(writeError && writeError.message || writeError));
            }).finally(() => {
              setPending((previous) => {
                const copy = Object.assign({}, previous);
                delete copy[key];
                return copy;
              });
            });
          } catch (writeError) {
            revert();
            setError("写入失败：" + String(writeError && writeError.message || writeError));
            setPending((previous) => {
              const copy = Object.assign({}, previous);
              delete copy[key];
              return copy;
            });
          }
        },
        [props, ctx]
      );
      if (props.view === "summary") {
        const values2 = state.values;
        const on = values2 ? SWITCHES.filter((entry) => resolveValue(values2, overlay, entry.key)).length : 0;
        return h("span", null, on + " / " + SWITCHES.length + " 个开关已开");
      }
      const values = state.values;
      const ready = state.status === "ready";
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "10px", padding: "6px 0" } },
        ...SWITCHES.map(
          (entry) => h(
            "label",
            {
              key: entry.key,
              style: {
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                cursor: ready ? "pointer" : "default",
                opacity: pending[entry.key] ? 0.55 : 1
              }
            },
            h("input", {
              type: "checkbox",
              checked: resolveValue(values, overlay, entry.key),
              disabled: isSwitchDisabled(ready, pending, entry.key),
              onChange: (event) => {
                const next = !!(event && event.target && event.target.checked);
                toggle(entry.key, next);
              },
              style: { marginTop: "3px" }
            }),
            h(
              "span",
              { style: { display: "flex", flexDirection: "column", gap: "2px" } },
              h("span", { style: { fontSize: "13px" } }, entry.label),
              h("span", { style: { fontSize: "12px", opacity: 0.6 } }, entry.hint)
            )
          )
        ),
        h(
          "div",
          { style: { fontSize: "12px", opacity: 0.6 } },
          ready ? "改动立刻生效，不用刷新页面。" : "读取设置中…（" + state.status + "）"
        ),
        error ? h("div", { style: { fontSize: "12px", color: "#c0392b" } }, error) : null,
        h(
          "div",
          { style: { fontSize: "11px", opacity: 0.4, fontFamily: "ui-monospace, monospace" } },
          SLOT_KEY + " · " + (state.source || "none")
        )
      );
    };
  }

  // src/client/index.js
  function apply(ctx) {
    const probe = createFeatureProbe();
    const listeners2 = /* @__PURE__ */ new Set();
    const host = {
      addListener(id, listener) {
        listeners2.add(listener);
        return () => {
          listeners2.delete(listener);
        };
      },
      listenerCount: () => listeners2.size
    };
    const container = createContainer({
      features: createFeatures(probe, host),
      ctx,
      // `h` is the late-bound runtime accessor, so features migrated in S2 can use it.
      env: { h, probe, host },
      readSwitches: (context, options) => readSwitches(context, options),
      cachedSwitches: () => cacheSwitches(),
      watchSwitches: (context, callback, options) => watchSwitches(context, callback, options),
      onError: (id, error) => console.error("[dsh-toolbox] " + id, error)
    });
    const card = createSettingsCard(ctx);
    const offCard = ctx.effect(
      () => ctx.slots.inject(
        SLOT,
        () => ctx.slots.register(
          { name: SLOT, key: SLOT_KEY },
          (props) => h(card, Object.assign({}, props, { ctx }))
        )
      ),
      "toolbox: settings card on the plugin row"
    );
    window.__DSH_TOOLBOX__ = {
      phaseOf: container.phaseOf,
      liveCount: container.liveCount,
      mounts: probe.count,
      listeners: host.listenerCount,
      slot: SLOT + "#" + SLOT_KEY
    };
    return ctx.effect(() => () => {
      try {
        if (typeof offCard === "function") offCard();
        else if (offCard && typeof offCard.dispose === "function") offCard.dispose();
      } catch (error) {
        console.error("[dsh-toolbox] removing the settings card failed", error);
      }
      Promise.resolve(container.dispose()).catch((error) => {
        console.error("[dsh-toolbox] container disposal failed", error);
      });
      listeners2.clear();
      if (window.__DSH_TOOLBOX__) delete window.__DSH_TOOLBOX__;
    }, "toolbox: dispose container");
  }
  window.__ModuleLoader__.load({
    id: "dsh-toolbox",
    factory(load) {
      installRuntime(load("react"));
      return {
        inject: ["slots", "locale"],
        apply
      };
    }
  });
})();
