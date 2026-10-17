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

  // src/client/scope.js
  function toDisposer(value) {
    if (value === void 0 || value === null) return null;
    if (typeof value === "function") return value;
    if (typeof value.dispose === "function") return () => value.dispose();
    throw new TypeError("dsh-toolbox: a disposer must be a function or expose dispose()");
  }
  function createScope(label = "scope") {
    const undo = [];
    let closed = false;
    return {
      label,
      /** Register one disposer. Returns it unchanged so callers can keep a handle. */
      track(value) {
        const disposer = toDisposer(value);
        if (disposer === null) return value;
        if (closed) {
          try {
            disposer();
          } catch (error) {
            console.error("[dsh-toolbox] late disposer failed", error);
          }
          return value;
        }
        undo.push(disposer);
        return value;
      },
      /** How many effects are currently held. Used by the tests. */
      size() {
        return undo.length;
      },
      /** Undo everything, newest first, each isolated. Idempotent. */
      dispose() {
        if (closed) return;
        closed = true;
        const pending = undo.splice(0).reverse();
        let first;
        for (const disposer of pending) {
          try {
            disposer();
          } catch (error) {
            if (first === void 0) first = error;
            console.error("[dsh-toolbox] disposer failed in " + label, error);
          }
        }
        if (first !== void 0) throw first;
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
    const wantOf = (feature, source) => source[feature.configKey] === true;
    function reversibleOnly(cache) {
      if (!cache || typeof cache !== "object") return {};
      const out = {};
      for (const feature of features) {
        if (feature.reversible && cache[feature.configKey] === true) out[feature.configKey] = true;
      }
      return out;
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
        try {
          scope.dispose();
        } catch (disposeError) {
          onError(feature.id, disposeError);
        }
        state.set(feature.id, OFF);
        return;
      }
      const superseded = disposed || generation.get(feature.id) !== mine || !wantOf(feature, values);
      if (superseded) {
        try {
          scope.dispose();
        } catch (error) {
          onError(feature.id, error);
        }
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
      if (!scope) return;
      try {
        scope.dispose();
      } catch (error) {
        onError(feature.id, error);
      }
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
    function schedule(next) {
      queue = queue.then(() => {
        if (!disposed) reconcile(next);
      }).catch((error) => onError("container", error));
      return queue;
    }
    function start() {
      if (typeof cachedSwitches === "function") {
        schedule(reversibleOnly(safeCall(cachedSwitches, onError)));
      }
      let settled;
      try {
        settled = Promise.resolve(readSwitches2(ctx));
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
      const off = typeof watchSwitches2 === "function" ? watchSwitches2(ctx, (next) => schedule(next)) : void 0;
      return off;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      markReady();
      for (const [, scope] of scopes) {
        try {
          scope.dispose();
        } catch (error) {
          onError("dispose", error);
        }
      }
      scopes.clear();
      state.clear();
    }
    const stopWatching = start();
    return {
      /** Take the switch values once more (used by tests). */
      feed: (next) => schedule(next),
      /** Whether a feature is currently mounted. */
      phaseOf: (id) => state.get(id) ?? OFF,
      /** Live scopes, for leak assertions. */
      liveCount: () => scopes.size,
      dispose() {
        try {
          if (typeof stopWatching === "function") stopWatching();
          else if (stopWatching && typeof stopWatching.dispose === "function") stopWatching.dispose();
        } catch (error) {
          onError("watch", error);
        }
        dispose();
      },
      /** Wait for the queue (tests). */
      settled: () => queue,
      /** Wait for the first reconcile driven by the real switch values. */
      ready: () => ready
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
    const { id, configKey, title, mount, reversible, defaultOn } = spec;
    if (typeof id !== "string" || id.length === 0) throw new TypeError("feature needs a string id");
    if (typeof configKey !== "string" || configKey.length === 0) {
      throw new TypeError("feature " + id + " needs a configKey");
    }
    if (typeof mount !== "function") throw new TypeError("feature " + id + " needs mount()");
    if (typeof reversible !== "boolean") {
      throw new TypeError("feature " + id + " must declare reversible: true|false");
    }
    if (defaultOn !== void 0 && typeof defaultOn !== "boolean") {
      throw new TypeError("feature " + id + " has a non-boolean defaultOn");
    }
    return Object.freeze({ id, configKey, title: title ?? id, mount, reversible, defaultOn: defaultOn ?? false });
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
      const off = host.addListener(id, () => {
      });
      env.track(off);
    };
    return defineFeatures([
      {
        id: "quote-reply",
        configKey: "quoteReply",
        title: "划词引用",
        reversible: true,
        defaultOn: true,
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
        defaultOn: true,
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
        defaultOn: true,
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
        defaultOn: true,
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
        defaultOn: true,
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
    const id = candidateIds().find((candidate) => served.includes(candidate)) ?? ROW_ID;
    try {
      return { form: forms.get(id), entryId: id };
    } catch (error) {
      return void 0;
    }
  }
  function readSwitches(ctx) {
    return new Promise((resolve) => {
      let tries = 0;
      const attempt = () => {
        const picked = pickForm(ctx);
        if (picked && picked.form && typeof picked.form.getSnapshot === "function") {
          try {
            const value = picked.form.getSnapshot().value;
            if (value && typeof value === "object") {
              resolve(Object.assign({}, value));
              return;
            }
          } catch (error) {
          }
        }
        tries += 1;
        if (tries >= 20) {
          resolve({});
          return;
        }
        setTimeout(attempt, 250);
      };
      attempt();
    });
  }
  function watchSwitches(ctx, callback) {
    const picked = pickForm(ctx);
    if (!picked || !picked.form || typeof picked.form.subscribe !== "function") return () => {
    };
    try {
      const off = picked.form.subscribe(() => {
        try {
          const value = picked.form.getSnapshot().value;
          if (value && typeof value === "object") callback(Object.assign({}, value));
        } catch (error) {
        }
      });
      return typeof off === "function" ? off : () => {
      };
    } catch (error) {
      return () => {
      };
    }
  }
  function cacheSwitches() {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.package !== PACKAGE || parsed.rowId !== ROW_ID) return {};
      return parsed.values && typeof parsed.values === "object" ? parsed.values : {};
    } catch (error) {
      return {};
    }
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
      env: { h: void 0, probe, host },
      readSwitches: (context) => readSwitches(context),
      cachedSwitches: () => cacheSwitches(),
      watchSwitches: (context, callback) => watchSwitches(context, callback),
      onError: (id, error) => console.error("[dsh-toolbox] " + id, error)
    });
    window.__DSH_TOOLBOX__ = {
      phaseOf: container.phaseOf,
      liveCount: container.liveCount,
      mounts: probe.count,
      listeners: host.listenerCount
    };
    return ctx.effect(() => () => {
      container.dispose();
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
