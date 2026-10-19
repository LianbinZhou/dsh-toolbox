"use strict";
(() => {
  // src/client/dsh-adapter.js
  var SERVICE_CHECKS = Object.freeze({
    slots: (service) => typeof service?.register === "function" && typeof service?.inject === "function",
    sessions: (service) => typeof service?.refresh === "function" || typeof service?.list === "object",
    configForms: (service) => typeof service?.get === "function",
    layout: (service) => typeof service?.selectPanel === "function",
    locale: (service) => typeof service?.register === "function"
  });
  var REQUIRED_SERVICES = Object.freeze(["slots", "locale", "sessions"]);
  function createDshAdapter(ctx, options = {}) {
    const label = options.label ?? "dsh-toolbox";
    const logger = options.logger ?? console;
    const warned = /* @__PURE__ */ new Set();
    const missing = [];
    const degraded = [];
    const warnOnce = (service, detail) => {
      if (warned.has(service)) return;
      warned.add(service);
      try {
        logger.warn("[" + label + "] 官方服务不可用: " + service + "（" + detail + "）—— 相关子功能已禁用，插件继续运行");
      } catch (error) {
      }
    };
    const probe = (name) => {
      let service;
      try {
        service = ctx ? ctx[name] : void 0;
      } catch (error) {
        service = void 0;
      }
      if (service === void 0 && ctx && typeof ctx.get === "function") {
        try {
          service = ctx.get(name);
        } catch (error) {
          service = void 0;
        }
      }
      const check = SERVICE_CHECKS[name];
      if (service === void 0) return { state: "missing" };
      if (typeof check === "function" && !check(service)) return { state: "degraded" };
      return { state: "ok", service };
    };
    const get = (name) => {
      const check = SERVICE_CHECKS[name];
      let service;
      try {
        service = ctx ? ctx[name] : void 0;
      } catch (error) {
        service = void 0;
      }
      if (service === void 0 && ctx && typeof ctx.get === "function") {
        try {
          service = ctx.get(name);
        } catch (error) {
          service = void 0;
        }
      }
      if (service === void 0) {
        if (!missing.includes(name)) missing.push(name);
        warnOnce(name, "不存在");
        return void 0;
      }
      if (typeof check === "function" && !check(service)) {
        if (!degraded.includes(name)) degraded.push(name);
        warnOnce(name, "形状不匹配，可能是官方改了接口");
        return void 0;
      }
      return service;
    };
    const require2 = (name) => {
      const service = get(name);
      if (service === void 0 && REQUIRED_SERVICES.includes(name)) {
        throw new Error(label + ": 缺少必需的官方服务 " + name);
      }
      return service;
    };
    const selfCheck = () => {
      const found = { missing: [], degraded: [], available: [] };
      for (const name of Object.keys(SERVICE_CHECKS)) {
        const probed = probe(name);
        if (probed.state === "missing") found.missing.push(name);
        else if (probed.state === "degraded") found.degraded.push(name);
        else found.available.push(name);
      }
      for (const name of found.missing) if (!missing.includes(name)) missing.push(name);
      for (const name of found.degraded) if (!degraded.includes(name)) degraded.push(name);
      return {
        label,
        ok: found.missing.length === 0 && found.degraded.length === 0,
        missing: found.missing,
        degraded: found.degraded,
        available: found.available
      };
    };
    return { get, require: require2, selfCheck, missing, degraded };
  }

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
    function mountFeature2(feature) {
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
        if (want && phase === OFF) mountFeature2(feature);
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
  var TRASH_PATH = "/api/archive-manager/trash";
  var RESTORE_PATH = "/api/archive-manager/restore";
  var PURGE_PATH = "/api/archive-manager/purge";
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
    function post(sessionId, credential, extra) {
      return fetchImpl(base() + DELETE_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: "1",
          [TOKEN_HEADER]: credential
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ sessionId, ...extra || {} })
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
      async delete(sessionId, title) {
        const extra = typeof title === "string" && title.length > 0 ? { title: title.slice(0, 120) } : void 0;
        if (disposed) return { ok: false, status: 0, reason: "disposed" };
        let credential;
        try {
          credential = token !== null ? token : await refresh();
        } catch (error) {
          return { ok: false, status: 0, reason: "token-unavailable" };
        }
        let response;
        try {
          response = await post(sessionId, credential, extra);
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
            response = await post(sessionId, fresh, extra);
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
      /** GET 回收箱列表（只含白名单字段）。 */
      async trash() {
        if (disposed) return { ok: false, rows: [], reason: "disposed" };
        const result = await authorized(TRASH_PATH, { method: "GET" });
        if (result.response === void 0) return { ok: false, rows: [], reason: result.reason };
        const body = await readJson(result.response);
        if (!result.response.ok || body?.ok === false) {
          return { ok: false, rows: [], reason: body?.reason ?? "request-failed", protectedCount: body?.protectedCount, maxProtected: body?.maxProtected };
        }
        return {
          ok: true,
          rows: Array.isArray(body?.rows) ? body.rows : [],
          protectedCount: body?.protectedCount,
          maxProtected: body?.maxProtected,
          keptDays: body?.keptDays
        };
      },
      /** POST 从回收箱恢复到原位。 */
      async restoreFromTrash(sessionId) {
        if (disposed) return { ok: false, status: 0, reason: "disposed" };
        const result = await authorized(RESTORE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId })
        });
        if (result.response === void 0) return { ok: false, status: 0, reason: result.reason };
        const body = await readJson(result.response);
        if (!result.response.ok) return { ok: false, status: result.status, reason: body?.reason ?? "request-failed" };
        return { ok: true, status: result.status, warning: body?.warning };
      },
      /** POST 彻底删除（必须 confirm）。 */
      async purge(sessionId) {
        if (disposed) return { ok: false, status: 0, reason: "disposed" };
        const result = await authorized(PURGE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, confirm: true })
        });
        if (result.response === void 0) return { ok: false, status: 0, reason: result.reason };
        const body = await readJson(result.response);
        if (!result.response.ok) return { ok: false, status: result.status, reason: body?.reason ?? "request-failed" };
        return { ok: true, status: result.status };
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

  // src/shared/reasons.js
  var REASON_MAP = Object.freeze({
    // —— 参数与状态 ——
    "invalid-id": { wire: "invalid-id", text: "会话 id 不合法" },
    "not-archived": { wire: "not-archived", text: "这个会话已经不在归档列表里了" },
    "no-longer-archived": { wire: "not-archived", text: "已经不在归档列表" },
    "dir-absent": { wire: "dir-absent", text: "会话目录已经不在了" },
    "already-deleted": { wire: "already-deleted", text: "这个会话已经删过了" },
    "delete-in-progress": { wire: "in-progress", text: "这个会话正在删除中" },
    // —— 存活与身份 ——
    "session-is-live": { wire: "live", text: "这个会话正在使用中，不能删除" },
    "session-became-live": { wire: "live", text: "会话刚被打开，已取消删除" },
    "identity-changed": { wire: "identity-changed", text: "会话目录已变化，已拒绝" },
    // —— 路径与磁盘 ——
    "unsafe-path": { wire: "unsafe-path", text: "路径不安全，已拒绝" },
    "unsafe-trash-root": { wire: "unsafe-path", text: "回收站位置不安全，已拒绝执行" },
    "cross-volume-trash": { wire: "cross-device", text: "回收箱和会话不在同一个磁盘，无法原子移动" },
    // —— 执行失败 ——
    "probe-failed": { wire: "probe-failed", text: "检查会话目录时出错" },
    "claim-failed": { wire: "claim-failed", text: "删除声明写入失败" },
    "move-failed": { wire: "remove-failed", text: "移入回收箱失败" },
    "restore-failed": { wire: "restore-failed", text: "恢复失败" },
    "purge-failed": { wire: "purge-failed", text: "彻底删除失败" },
    // —— 回收箱 ——
    "cleanup-only": { wire: "cleanup-only", text: "目录已不在，只做了清理" },
    "cleanup-pending": { wire: "cleanup-pending", text: "已移入回收箱，但归档标记清理未完成" },
    "journal-corrupt": { wire: "journal-corrupt", text: "回收站状态文件损坏，已停止删除（请人工检查）" },
    "trash-full": { wire: "trash-full", text: "回收箱已满（上限 200）：请先恢复或彻底删除，再继续" },
    "no-entry": { wire: "no-entry", text: "没有这条记录" },
    "not-in-trash": { wire: "not-in-trash", text: "这条不在回收箱里" },
    "confirm-required": { wire: "confirm-required", text: "彻底删除需要二次确认" },
    // —— 兜底 ——
    "request-failed": { wire: "request-failed", text: "操作失败" }
  });
  var WIRE_REASONS = Object.freeze(new Set(Object.values(REASON_MAP).map((entry) => entry.wire)));
  function reasonText(reason) {
    if (typeof reason === "string") {
      const entry = REASON_MAP[reason];
      if (entry) return entry.text;
      for (const candidate of Object.values(REASON_MAP)) {
        if (candidate.wire === reason) return candidate.text;
      }
    }
    return REASON_MAP["request-failed"].text;
  }
  var INTERNAL_REASONS = Object.freeze(Object.keys(REASON_MAP));

  // src/client/features/archive-panel-model.js
  var CLIENT_REASON_TEXT = Object.freeze({
    "refresh-required": "需要刷新页面（凭证已失效）",
    "token-unavailable": "拿不到凭证：请确认第 7 个开关已开启，然后刷新页面",
    "network-error": "网络错误：宿主可能正在重启",
    disposed: "面板已卸载，请刷新页面",
    "archive-session-adapter-unavailable": "宿主还没接上会话服务，归档接口暂不可用",
    "http-401": "宿主还是旧代码（回收箱接口未加载）：请重启 DSH，然后刷新页面",
    "http-404": "接口没有注册：请打开第 7 个开关",
    "http-503": "服务未就绪"
  });
  var REASON_TEXT = Object.freeze({
    ...Object.fromEntries(Object.entries(CLIENT_REASON_TEXT))
  });
  function reasonTextFor(reason) {
    if (typeof reason === "string" && CLIENT_REASON_TEXT[reason]) return CLIENT_REASON_TEXT[reason];
    return reasonText(reason);
  }
  function createArchivePanel({ client, isEnabled }) {
    let rows = [];
    let titles = {};
    let pending = null;
    let viewMode = "archive";
    let trashRows = [];
    let trashMeta = {};
    let purgePending = null;
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
      return reasonTextFor(reason);
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
    async function act(kind, id, title) {
      if (!enabled()) return { ok: false, reason: "disabled" };
      const result = kind === "delete" ? await client.delete(id, title) : await client.unarchive(id);
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
      /** 切换页签。回收箱不新增入口，只在这里切。 */
      switchTo(mode) {
        viewMode = mode === "trash" ? "trash" : "archive";
        purgePending = null;
        message = "";
        return viewMode;
      },
      /** 加载回收箱列表。开关关闭时不发请求。 */
      async refreshTrash() {
        if (!enabled()) {
          viewMode = "trash";
          state = "disabled";
          message = "归档 HTTP 接口未启用";
          trashRows = [];
          return { ok: false, reason: "disabled" };
        }
        viewMode = "trash";
        const result = await client.trash();
        if (result.ok) {
          trashRows = result.rows;
          titles = typeof client.titleMap === "function" ? await client.titleMap() : titles;
          trashMeta = { protectedCount: result.protectedCount, maxProtected: result.maxProtected, keptDays: result.keptDays };
          state = "ready";
          message = "";
          return { ok: true };
        }
        state = "error";
        message = phrase(result.reason);
        return { ok: false, reason: result.reason };
      },
      /** 从回收箱恢复。 */
      async restoreTrash(id) {
        if (!enabled()) return { ok: false, reason: "disabled" };
        const result = await client.restoreFromTrash(id);
        if (!result.ok) {
          message = phrase(result.reason);
          return result;
        }
        await this.refreshTrash();
        message = result.warning === "cleanup-pending" ? phrase("cleanup-pending") : "";
        return result;
      },
      /** 彻底删除：先问，再执行。 */
      askPurge(id) {
        purgePending = id;
        message = "";
      },
      cancelPurge() {
        purgePending = null;
      },
      async confirmPurge() {
        const id = purgePending;
        purgePending = null;
        if (id === null) return { ok: false, reason: "nothing-to-purge" };
        const result = await client.purge(id);
        if (!result.ok) {
          message = phrase(result.reason);
          return result;
        }
        message = "";
        await this.refreshTrash();
        return result;
      },
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
        return act("delete", id, titles[id]);
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
              label: titles[row.id] || row.title || "会话 " + String(row.id).slice(-8)
            })
          ),
          canDelete: enabled(),
          pending,
          view: viewMode,
          trash: viewMode === "trash" ? {
            rows: trashRows.map((row) => ({
              id: row.id,
              // 标题优先：inventory 里的 → journal 里记下的 → id 尾段兜底。
              label: titles[row.id] || row.title || "会话 " + String(row.id).slice(-8),
              phase: row.phase,
              at: row.at,
              keptDays: row.keptDays,
              // 剩余天数按到期时间算：keptDays 是总期，不是剩余。
              remainingDays: typeof row.expiresAt === "number" && row.expiresAt > 0 ? Math.max(0, Math.floor((row.expiresAt - Date.now()) / 864e5)) : row.keptDays
            })),
            protectedCount: trashMeta.protectedCount,
            maxProtected: trashMeta.maxProtected,
            keptDays: trashMeta.keptDays
          } : null,
          purgePending
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
  async function refreshHostSessionsOf(ctx, adapter) {
    const dsh = adapter ?? createDshAdapter(ctx);
    const sessions = dsh.get("sessions");
    if (sessions === void 0 || typeof sessions.refresh !== "function") return false;
    try {
      await sessions.refresh();
      return true;
    } catch (error) {
      console.warn("[dsh-toolbox] sessions.refresh 失败（侧栏可能要手动刷新）", error);
      return false;
    }
  }
  function phaseLabel(phase) {
    if (phase === "trashed") return "待清理";
    if (phase === "cleaned") return "已移入回收箱";
    if (phase === "done") return "已彻底删除";
    return "处理中";
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
    const PANEL_CSS = [
      ".dsh-toolbox-archive{display:flex;flex-direction:column;height:100%;min-height:0;max-height:100%;overflow:hidden;box-sizing:border-box;padding:14px;gap:10px}",
      ".dsh-toolbox-archive header{display:flex;align-items:baseline;gap:8px;flex:0 0 auto}",
      ".dsh-toolbox-archive-count{color:var(--dsw-alias-text-secondary,#888);font-size:12px}",
      ".dsh-toolbox-archive-tabs{display:flex;gap:6px;flex:0 0 auto}",
      '.dsh-toolbox-archive-tabs button[aria-pressed="true"]{background:var(--dsw-alias-bg-selected,#e8f0fe);border-color:var(--dsw-alias-border-strong,#8ab4f8);font-weight:600}',
      ".dsh-toolbox-archive ul{flex:1 1 auto;min-height:0;max-height:calc(100dvh - 220px);overflow-y:auto;overscroll-behavior:contain;margin:0;padding:0 2px 0 0;list-style:none;display:flex;flex-direction:column;gap:6px}",
      ".dsh-toolbox-archive li{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-1,#e3e3e3);border-radius:8px;background:var(--dsw-alias-bg-1,#fff)}",
      ".dsh-toolbox-archive-title{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsh-toolbox-archive-title strong{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-toolbox-archive-id{color:var(--dsw-alias-text-secondary,#999);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-toolbox-archive button{flex:0 0 auto;padding:4px 10px;border:1px solid var(--dsw-alias-border-1,#d5d5d5);border-radius:6px;background:var(--dsw-alias-bg-1,#fff);color:inherit;cursor:pointer;font-size:12px;line-height:1.6}",
      ".dsh-toolbox-archive button:hover:not(:disabled){background:var(--dsw-alias-bg-hover,#f3f3f3)}",
      ".dsh-toolbox-archive button:disabled{opacity:.5;cursor:not-allowed}",
      ".dsh-toolbox-archive button.danger{color:#b3261e;border-color:#b3261e}",
      ".dsh-toolbox-archive button.danger:hover:not(:disabled){background:rgba(179,38,30,.08)}",
      ".dsh-toolbox-archive-confirm{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #b3261e;border-radius:8px;background:rgba(179,38,30,.06);flex-wrap:wrap}",
      ".dsh-toolbox-archive-empty,.dsh-toolbox-archive-note{color:var(--dsw-alias-text-secondary,#888);font-size:12px;margin:0}",
      ".dsh-toolbox-archive-note{color:#b3261e}"
    ].join("\n");
    function ArchiveView() {
      const [view, setView] = useState(() => panel.view());
      const [busy, setBusy] = useState(false);
      const sync = () => setView(panel.view());
      useEffect(() => {
        let live = true;
        void panel.refresh().then(() => {
          if (live) sync();
        });
        return () => {
          live = false;
        };
      }, []);
      const refreshHostSessions = () => refreshHostSessionsOf(ctx);
      const run = (action) => async () => {
        setBusy(true);
        try {
          await action();
        } finally {
          await refreshHostSessions();
          sync();
          setBusy(false);
        }
      };
      const dangerStyle = { color: "#b3261e", borderColor: "#b3261e", fontWeight: "600" };
      const rowTitle = (row, extra) => h("span", { class: "dsh-toolbox-archive-title" }, [
        h("strong", null, row.label),
        h("div", { class: "dsh-toolbox-archive-id" }, extra)
      ]);
      return h("div", { class: "dsh-toolbox-archive" }, [
        h("style", null, PANEL_CSS),
        h("header", null, [
          h("strong", null, "历史归档"),
          h("span", { class: "dsh-toolbox-archive-count" }, view.view === "trash" ? "回收箱 " + (view.trash?.protectedCount ?? 0) + " / " + (view.trash?.maxProtected ?? 200) : view.rows.length === 0 ? "共 0 条" : "共 " + view.rows.length + " 条")
        ]),
        // 二级页签：不新增侧栏入口，只在面板内切换。
        h("div", { class: "dsh-toolbox-archive-tabs" }, [
          h("button", {
            type: "button",
            disabled: busy,
            "aria-pressed": view.view === "archive" ? "true" : "false",
            onClick: () => {
              panel.switchTo("archive");
              void panel.refresh().then(sync);
            }
          }, "归档"),
          h("button", {
            type: "button",
            disabled: busy,
            "aria-pressed": view.view === "trash" ? "true" : "false",
            onClick: () => {
              panel.switchTo("trash");
              void panel.refreshTrash().then(sync);
            }
          }, "回收箱")
        ]),
        view.message ? h("p", { class: "dsh-toolbox-archive-note" }, view.message) : null,
        view.view === "archive" ? h("div", null, [
          view.pending ? h("div", { class: "dsh-toolbox-archive-confirm" }, [
            h("span", null, "移入回收箱（可恢复，到期自动彻底删除）"),
            h("button", { type: "button", style: dangerStyle, onClick: run(() => panel.confirmRemove()) }, "入回收箱"),
            h("button", { type: "button", onClick: () => {
              panel.cancelRemove();
              sync();
            } }, "取消")
          ]) : null,
          view.rows.length === 0 && !view.message ? h("p", { class: "dsh-toolbox-archive-empty" }, "没有归档会话") : null,
          h("ul", null, view.rows.map(
            (row) => h("li", { key: row.id }, [
              rowTitle(row, row.id),
              h("button", { type: "button", disabled: busy || !view.canDelete, onClick: run(() => panel.unarchive(row.id)) }, "恢复"),
              h("button", {
                type: "button",
                class: "danger",
                style: dangerStyle,
                disabled: busy || !view.canDelete,
                onClick: () => {
                  panel.askRemove(row.id);
                  sync();
                }
              }, "删除")
            ])
          ))
        ]) : null,
        view.view === "trash" ? h("div", null, [
          view.purgePending ? h("div", { class: "dsh-toolbox-archive-confirm" }, [
            h("span", null, "物理删除，无法恢复。确定吗？"),
            h("button", { type: "button", style: dangerStyle, onClick: run(() => panel.confirmPurge()) }, "彻底删除"),
            h("button", { type: "button", onClick: () => {
              panel.cancelPurge();
              sync();
            } }, "取消")
          ]) : null,
          view.trash.rows.length === 0 && !view.message ? h("p", { class: "dsh-toolbox-archive-empty" }, "回收箱是空的") : null,
          h("ul", null, view.trash.rows.map(
            (row) => h("li", { key: row.id }, [
              rowTitle(row, phaseLabel(row.phase) + " · " + (row.remainingDays === 0 ? "今天到期" : "剩余 " + row.remainingDays + " 天")),
              h("button", { type: "button", disabled: busy, onClick: run(() => panel.restoreTrash(row.id)) }, "恢复"),
              h("button", {
                type: "button",
                class: "danger",
                style: dangerStyle,
                disabled: busy,
                onClick: () => {
                  panel.askPurge(row.id);
                  sync();
                }
              }, "彻底删除")
            ])
          ))
        ]) : null
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

  // src/client/features/plugin-zh.js
  var PLUGIN_ZH_DICT = Object.freeze({
    /* --- official core --- */
    "The shared dsh core as a profile bundle: the first patch layer of base-backed profiles, inserting core rows over the empty profile root": "DSH 核心本体（地基）：作为 profile 的第一层，把核心组件插到空白的 profile 根上。所有别的插件都装在它上面，不能关。",
    "The dsh browser-surface bundle: the web patch layer over dsh-base plus the runtime glue plugin (frontend dist serving, bash runtime variables, URL line)": "网页外壳：在核心之上补齐整个网页界面（前端资源、运行时变量、访问地址）。你现在看到的这个界面就是它，不能关。",
    /* --- vision / memory / market --- */
    "Plug-in vision for text-only LLMs, powered by the free Antigravity CLI": "给「只认文字」的模型加眼睛：让 AI 能看图（截图、图表、扫描件）。读你截图靠它，别关。",
    "Composable, view-based memory for DeepSeek Harness. Pluggable sources and strategies, with layered memory out of the box.": "分层记忆：可插拔的记忆源与策略，把你的偏好、项目事实、长期知识分开存。每回合提示里那堆记忆就是它。",
    "Visual plugin market inside DeepSeek Harness — browse, search, and one-click install community plugins. · DSH 可视化插件市场：逛一逛，点一下，装好。": "可视化插件市场：逛一逛、搜一搜、点一下装好社区插件。",
    "Archive manager for the dsh web GUI: a sidebar entry that lists archived sessions, restores them back to the workspace, and permanently deletes them after confirmation": "会话归档面板：列出已归档的会话，能一键恢复到工作区，也能二次确认后永久删除。",
    /* --- the linxin666 family --- */
    "Session archive management for DSH Web: centralized inventory, batch archive/restore, physical delete with family cascade, and optional auto-archive / auto-cleanup policies.": "会话归档管理：集中清点、批量归档/恢复、连带删除，还能设「自动归档 / 自动清理」规则。",
    "External dsh web GUI plugin: a blank-session git branch selector + Git graph, with real host-side git operations and guards, as a dsh profile bundle": "Git 图谱 + 分支选择器：空白会话里能选 git 分支，真实在宿主侧跑 git 操作，带安全保护。",
    "DSH skill center: browse loaded skills by source (bundled / project / user / custom / runtime), enable or disable, create and delete, in a web GUI panel.": "技能中心：按来源（内置 / 项目 / 用户 / 自定义 / 运行时）浏览已加载的技能，能启用停用、新建删除。",
    "Self-update plugin for the dsh web GUI: probes npm for newer family releases and runs the owning profile's pnpm update in place, from a sidebar trigger beside the settings seat with a release-notes panel": "自更新：去 npm 查这一族插件有没有新版本，就地跑 pnpm 更新，侧栏有入口，还带更新日志面板。",
    "Usage statistics plugin for the dsh web GUI: per-provider balance and coding-plan quota detection plus a live token usage ledger, with a compact price glance card above the sidebar's Settings row": "用量统计：查各服务商的余额和套餐额度，还有一份实时 token 用量账本，压在侧栏「设置」上方。",
    /* --- the plugins this machine actually runs --- */
    "DSH Web UI plugin: automatically sends a localized continue prompt when a request is interrupted by network errors or other non-human causes": "自动续跑：会话被网络错误、超时、或「只有思考没正文就结束」打断时，自动替你补一句「继续」，让任务接着跑。带退避和死循环熔断。",
    /* --- official experimental bundles --- */
    "Agent Teams collaboration, tools, and Web UI in one experimental bundle": "Agent 团队：多个 AI 分工协作（队长 + 队员、共享任务板、互相发消息），含配套工具和界面。",
    "Per-tool LLM authorization review for the DeepSeek Harness Auto permission preset": "自动审查：在「自动」权限档位下，每个工具调用都先让模型复核一遍再放行。",
    "Let agents add a “powered by dsh” badge to documents, pull requests, and other outputs.": "给文档、PR 等产出加上「powered by dsh」角标。",
    "Experimental machine translation of expanded reasoning": "把展开的推理过程机翻成中文显示。",
    "Run explicitly requested repeated work with fresh agents.": "Ralph 循环：按你的明确要求，用「全新的子代理」一轮一轮反复打磨同一个目标。",
    "Optional Web bundle for raw Session logs and Chat node inspection": "检视器：直接看会话的原始日志和每一条消息节点，排障时有用。",
    "Refresh session titles as new human prompts arrive.": "每来一条新提问就刷新会话标题。",
    "Keep shell processes alive across tool calls.": "持久终端：shell 进程跨工具调用存活，长命令不用重开。",
    "Model tool that creates and enters a new Git worktree": "让我能新建并进入一个 Git worktree（并行开发不同分支用）。",
    "Experimental voice input with local SenseVoice; downloads its runtime on first use": "语音输入：本地 SenseVoice 模型，第一次用时会自动下载运行库。",
    "Give Agents tools to search and read earlier sessions from the current workspace.": "给我「搜索/读取历史会话」的工具，能在当前工作区里翻以前的对话。",
    "Experimental custom plugin markets: a Discover tab that browses and installs bundles from plugin market indexes": "自定义插件市场源：多一个「发现」页，从别的插件市场索引里浏览和安装。",
    /* --- other profile bundles --- */
    "The dsh ACP profile bundle: automation-only JSON-RPC stdio and process lifecycle over dsh-base": "ACP 档：只做自动化的 JSON-RPC stdio 接口和进程生命周期管理，没有界面。",
    "The dsh one-shot bundle: a direct core Agent/Session runner over dsh-base with no Host, HTTP, or browser layer": "一次性执行档：直接跑核心 Agent / 会话，没有界面、没有 HTTP、没有浏览器层。",
    "The dsh SDK profile bundle: stdio JSON-RPC serving and process lifecycle over dsh-base": "SDK 档：通过 stdio 提供 JSON-RPC 服务，给别的程序调用 DSH 用。",
    "The standalone minimal SDK profile bundle: JSON-RPC, one DeepSeek adapter, persistent shell, and JSONL sessions": "极简 SDK 档：JSON-RPC + 一个 DeepSeek 适配器 + 持久 shell + JSONL 会话，最小可跑组合。"
  });
  var PREFIX_LEN = 40;
  var MIN_LEN = 18;
  function normalize(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }
  function buildLookup(dict) {
    const table = /* @__PURE__ */ new Map();
    const prefix = /* @__PURE__ */ new Map();
    const collisions = /* @__PURE__ */ new Set();
    for (const [en, zh] of Object.entries(dict)) {
      const key = normalize(en);
      table.set(key, zh);
      if (key.length >= PREFIX_LEN) {
        const head = key.slice(0, PREFIX_LEN);
        if (prefix.has(head) && prefix.get(head) !== zh) collisions.add(head);
        else prefix.set(head, zh);
      }
    }
    for (const head of collisions) prefix.delete(head);
    return (text) => {
      const key = normalize(text);
      if (key.length < MIN_LEN) return void 0;
      const exact = table.get(key);
      if (exact !== void 0) return exact;
      if (key.length < PREFIX_LEN) return void 0;
      return prefix.get(key.slice(0, PREFIX_LEN));
    };
  }
  var SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
  function looksEnglish(text) {
    return text.length >= 40 && /^[\x20-\x7E\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00B7]+$/.test(text);
  }
  function translateTextNode(node, lookup, applied) {
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName)) return false;
    const raw = node.nodeValue;
    if (!raw) return false;
    const previous = applied.get(node);
    if (previous) {
      if (node.nodeValue === previous.translated) return true;
      applied.delete(node);
    }
    const zh = lookup(raw);
    if (zh === void 0) return false;
    if (raw !== zh) {
      node.nodeValue = zh;
      applied.set(node, { original: raw, translated: zh });
    }
    return true;
  }
  function pruneApplied(applied) {
    if (!applied || typeof applied.keys !== "function") return 0;
    let removed = 0;
    for (const node of applied.keys()) {
      if (!node || node.isConnected === false) {
        applied.delete(node);
        removed += 1;
      }
    }
    return removed;
  }
  function restoreApplied(applied) {
    let restored = 0;
    if (!applied || typeof applied.keys !== "function") return restored;
    for (const node of [...applied.keys()]) {
      const record = applied.get(node);
      applied.delete(node);
      if (!node || !record) continue;
      if (node.isConnected === false) continue;
      if (node.nodeValue !== record.translated) continue;
      try {
        node.nodeValue = record.original;
        restored += 1;
      } catch (error) {
      }
    }
    return restored;
  }
  function mountPluginZh({ locale = "zh", doc, win } = {}) {
    const documentRef = doc ?? (typeof document !== "undefined" ? document : void 0);
    const windowRef = win ?? (typeof window !== "undefined" ? window : void 0);
    const lookup = buildLookup(PLUGIN_ZH_DICT);
    const applied = /* @__PURE__ */ new Map();
    const state = { unknown: /* @__PURE__ */ new Set(), replaced: 0, passes: 0, lastPass: 0 };
    const enabled = String(locale).toLowerCase().startsWith("zh");
    let observer = null;
    let scheduled = false;
    let disposed = false;
    let toastShown = false;
    const requestIdle = windowRef && typeof windowRef.requestIdleCallback === "function" ? windowRef.requestIdleCallback.bind(windowRef) : (fn) => setTimeout(fn, 0);
    const insidePluginList = (element) => {
      let node = element;
      while (node && node !== documentRef.body) {
        if (node.hasAttribute && (node.hasAttribute("data-plugin-rows") || node.hasAttribute("data-plugin-inventory"))) return true;
        node = node.parentElement;
      }
      return false;
    };
    const pass = (root) => {
      if (!enabled) return 0;
      if (!root || !documentRef || !documentRef.body || disposed) return 0;
      state.lastPass = 0;
      state.passes += 1;
      if (root.nodeType === 3) {
        if (translateTextNode(root, lookup, applied)) state.lastPass += 1;
        pruneApplied(applied);
        state.replaced += state.lastPass;
        return state.lastPass;
      }
      const walker = documentRef.createTreeWalker(root, 4, {
        acceptNode(candidate) {
          const parent = candidate.parentElement;
          if (!parent || SKIP_TAGS.has(parent.tagName)) return 2;
          return 1;
        }
      });
      const nodes = [];
      let current;
      while (current = walker.nextNode()) nodes.push(current);
      for (const node of nodes) {
        if (translateTextNode(node, lookup, applied)) state.lastPass += 1;
        else {
          const key = normalize(node.nodeValue ?? "");
          if (looksEnglish(key) && node.parentElement && insidePluginList(node.parentElement)) state.unknown.add(key);
        }
      }
      state.replaced += state.lastPass;
      pruneApplied(applied);
      return state.lastPass;
    };
    const toast = (count) => {
      if (toastShown || count <= 0 || !documentRef || !documentRef.body) return;
      toastShown = true;
      try {
        const box = documentRef.createElement("div");
        box.id = "dsh-toolbox-zh-toast";
        box.textContent = "插件说明已汉化：本页替换 " + count + " 处";
        box.style.cssText = [
          "position:fixed",
          "right:16px",
          "bottom:16px",
          "z-index:2147483000",
          "padding:8px 14px",
          "border-radius:8px",
          "background:rgba(20,20,22,.92)",
          "color:#fff",
          'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
          "box-shadow:0 6px 20px rgba(0,0,0,.28)",
          "pointer-events:none",
          "opacity:1",
          "transition:opacity .6s ease"
        ].join(";");
        documentRef.body.appendChild(box);
        setTimeout(() => {
          box.style.opacity = "0";
        }, 4200);
        setTimeout(() => {
          box.remove();
        }, 5e3);
      } catch (error) {
      }
    };
    const runNow = () => {
      if (disposed || !enabled) return 0;
      const changed = pass(documentRef.body);
      if (changed > 0) {
        toast(state.replaced);
        console.info("[dsh-toolbox] 插件汉化：本次替换 " + changed + " 处，累计 " + state.replaced);
      }
      return changed;
    };
    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      requestIdle(() => {
        scheduled = false;
        runNow();
      }, { timeout: 500 });
    };
    const begin = () => {
      if (disposed) return;
      if (!documentRef || !documentRef.body) return;
      if (!enabled) {
        console.info("[dsh-toolbox] 插件汉化：界面语言不是中文，跳过");
        return;
      }
      runNow();
      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(schedule);
        observer.observe(documentRef.body, { childList: true, subtree: true, characterData: true });
      }
    };
    if (documentRef && documentRef.body) begin();
    else if (documentRef && typeof documentRef.addEventListener === "function") {
      documentRef.addEventListener("DOMContentLoaded", begin, { once: true });
    }
    console.info("[dsh-toolbox] 插件汉化启动，locale=" + locale + "，词条=" + Object.keys(PLUGIN_ZH_DICT).length);
    return {
      state,
      lookup,
      toast,
      /** 断开 observer 并把所有替换还原成英文。 */
      dispose() {
        disposed = true;
        if (observer) {
          try {
            observer.disconnect();
          } catch (error) {
          }
          observer = null;
        }
        try {
          const box = documentRef && documentRef.getElementById ? documentRef.getElementById("dsh-toolbox-zh-toast") : null;
          if (box) box.remove();
        } catch (error) {
        }
        return restoreApplied(applied);
      }
    };
  }
  function mountFeature(ctx, env) {
    const dsh = createDshAdapter(ctx);
    const localeService = dsh.get("locale");
    let locale = "zh";
    try {
      const snapshot = localeService && typeof localeService.getSnapshot === "function" ? localeService.getSnapshot() : void 0;
      const active = snapshot && (snapshot.active || snapshot.locale);
      if (active !== void 0) locale = String(active).toLowerCase();
    } catch (error) {
    }
    const handle = mountPluginZh({ locale });
    env.track(() => handle.dispose());
    return () => handle.dispose();
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
        // 可逆：关掉必须把英文还原回去（S5 从独立插件迁入时新增的能力）。
        reversible: true,
        // 一行注册：逻辑全在 features/plugin-zh.js（读 locale 也已走 adapter）。
        mount(ctx, env) {
          probe.bump("plugin-zh");
          track("plugin-zh", env);
          return mountFeature(ctx, env);
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
  var TRASH_KEPT_DAYS_OPTIONS = Object.freeze([3, 7, 14, 30, 60]);
  var TRASH_KEPT_DAYS_DEFAULT = 7;

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
  function writeSetting(props, ctx, key, value) {
    const form = props && props.form;
    if (form && typeof form.mutate === "function") {
      return form.mutate([{ op: "set", path: [key], value }], revisionOf(form));
    }
    const picked = pickForm(ctx);
    if (picked && picked.form && typeof picked.form.set === "function") {
      return picked.form.set(key, value);
    }
    throw new Error("no writable settings form");
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
        // 回收箱保留天数：7 只是默认值，用户可以自己选。
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: "10px", fontSize: "13px" } },
          h("span", null, "回收箱保留天数"),
          h(
            "select",
            {
              value: String(values && values.trashKeptDays || TRASH_KEPT_DAYS_DEFAULT),
              disabled: !ready,
              onChange: (event) => {
                const next = Number(event && event.target && event.target.value);
                if (!Number.isFinite(next)) return;
                setError("");
                try {
                  Promise.resolve(writeSetting(props, ctx, "trashKeptDays", next)).then((ok) => {
                    if (ok === false) setError("服务拒绝了这次写入，天数没有改");
                  });
                } catch (writeError) {
                  setError("写入失败：" + String(writeError && writeError.message || writeError));
                }
              },
              style: { padding: "3px 8px", borderRadius: "6px" }
            },
            ...TRASH_KEPT_DAYS_OPTIONS.map((days) => h("option", { key: String(days), value: String(days) }, days + " 天"))
          ),
          h("span", { style: { fontSize: "12px", opacity: 0.6 } }, "到期后自动彻底删除")
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
    const dsh = createDshAdapter(ctx);
    window.__DSH_TOOLBOX__ = {
      phaseOf: container.phaseOf,
      liveCount: container.liveCount,
      mounts: probe.count,
      listeners: host.listenerCount,
      slot: SLOT + "#" + SLOT_KEY,
      selfCheck: dsh.selfCheck
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
        inject: ["slots", "locale", "sessions"],
        apply
      };
    }
  });
})();
