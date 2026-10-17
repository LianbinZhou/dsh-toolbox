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
    const { id, configKey, title, mount, reversible } = spec;
    if (typeof id !== "string" || id.length === 0) throw new TypeError("feature needs a string id");
    if (typeof configKey !== "string" || configKey.length === 0) {
      throw new TypeError("feature " + id + " needs a configKey");
    }
    if (typeof mount !== "function") throw new TypeError("feature " + id + " needs mount()");
    if (typeof reversible !== "boolean") {
      throw new TypeError("feature " + id + " must declare reversible: true|false");
    }
    return Object.freeze({ id, configKey, title: title ?? id, mount, reversible });
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
          track("quote-reply", env);
        }
      },
      {
        id: "panel-menu",
        configKey: "panelMenu",
        title: "面板收纳",
        reversible: true,
        mount(ctx, env) {
          probe.bump("panel-menu");
          track("panel-menu", env);
        }
      },
      {
        id: "draft-saver",
        configKey: "draftSaver",
        title: "草稿保险箱",
        reversible: false,
        mount(ctx, env) {
          probe.bump("draft-saver");
          track("draft-saver", env);
        }
      },
      {
        id: "archive-panel",
        configKey: "archivePanel",
        title: "历史归档",
        reversible: false,
        mount(ctx, env) {
          probe.bump("archive-panel");
          track("archive-panel", env);
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
    const { isCancelled = () => false } = options;
    let stopped = false;
    let unsubscribe;
    let timer;
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
        timer = setTimeout(bind, RETRY_MS);
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
        timer = setTimeout(bind, RETRY_MS);
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

  // src/shared/switches.js
  var SWITCHES = Object.freeze([
    { key: "quoteReply", label: "划词引用", hint: "划选对话文字后浮出「引用 / 复制」" },
    { key: "draftSaver", label: "草稿保险箱", hint: "没发送的内容不会丢" },
    { key: "panelMenu", label: "面板收纳", hint: "把侧栏的面板入口收进一个菜单" },
    { key: "archivePanel", label: "历史归档", hint: "列归档会话、一键恢复、删除" },
    { key: "pluginZh", label: "插件说明汉化", hint: "插件管理页的英文简介换成中文" },
    { key: "sessionSearch", label: "会话搜索（宿主工具）", hint: "给 AI 一个 session_search 工具；不影响侧栏搜索" }
  ]);
  var SWITCH_KEYS = Object.freeze(SWITCHES.map((entry) => entry.key));
  var CLIENT_SWITCH_KEYS = Object.freeze(
    SWITCHES.filter((entry) => entry.key !== "sessionSearch").map((entry) => entry.key)
  );

  // src/client/form.js
  var SLOT = "plugins.row.config";
  var SLOT_KEY = "dsh-toolbox#toolbox";
  var RETRY_MS2 = 150;
  var MAX_RETRIES2 = 40;
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
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        let alive = true;
        let tries = 0;
        let unsubscribe;
        let timer;
        const apply2 = (values2, source) => {
          if (!alive || !values2) return true;
          storeSwitches(values2);
          setState({ status: "ready", values: values2, source });
          return true;
        };
        const attempt = () => {
          if (!alive) return;
          const fromProps = valuesFromPropsForm(props.form);
          if (fromProps && apply2(fromProps, "props.form")) return;
          const picked = pickForm(ctx);
          const values2 = picked ? valuesOf(picked.form) : void 0;
          if (values2 && apply2(values2, "configForms")) {
            try {
              unsubscribe = picked.form.subscribe(() => {
                const next = valuesOf(picked.form);
                if (next) apply2(next, "configForms");
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
            } catch (error2) {
            }
          }
        };
      }, [props.form]);
      const toggle = useCallback(
        (key, next) => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            Promise.resolve(writeSwitch(props, ctx, key, next)).then((ok) => {
              if (ok === false) setError("服务拒绝了这次写入");
            }).catch((writeError) => setError(String(writeError && writeError.message || writeError))).finally(() => setBusy(false));
          } catch (writeError) {
            setError(String(writeError && writeError.message || writeError));
            setBusy(false);
          }
        },
        [busy, props, ctx]
      );
      if (props.view === "summary") {
        const values2 = state.values;
        const on = values2 ? SWITCHES.filter((entry) => values2[entry.key] === true).length : 0;
        return h("span", null, on + " / " + SWITCHES.length + " 个开关已开");
      }
      const values = state.values;
      const ready = state.status === "ready";
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "10px", padding: "6px 0" } },
        ...SWITCHES.map(
          (entry, index) => h(
            "label",
            {
              key: entry.key,
              style: { display: "flex", alignItems: "flex-start", gap: "10px", cursor: ready ? "pointer" : "default" }
            },
            h("input", {
              type: "checkbox",
              checked: ready ? values[entry.key] === true : false,
              disabled: !ready || busy,
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
    const listeners = /* @__PURE__ */ new Set();
    const host = {
      addListener(id, listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      listenerCount: () => listeners.size
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
      listeners.clear();
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
