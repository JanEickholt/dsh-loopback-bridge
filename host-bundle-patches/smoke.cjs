const fs = require("node:fs");
const vm = require("node:vm");
const code = fs.readFileSync("client.js", "utf8");
// dsh-relay hunk: frames live on the bridge's own origin; same-origin reads of the frame are gone.
if (!code.includes("function relayOrigin()")) throw new Error("dsh-relay hunk missing: no relayOrigin()");
if (code.includes("dshAddressPoll") || code.includes("contentWindow.location.href")) throw new Error("same-origin frame reads remain");
const messageListeners = [];
const location = { origin: "http://127.0.0.1:3080", protocol: "http:", hostname: "127.0.0.1" };
const fakeWindow = {
  __ModuleLoader__: { load(def) { globalThis.__capturedFactory = def.factory; globalThis.__capturedId = def.id; } },
  addEventListener(type, fn) { if (type === "message") messageListeners.push(fn); }
};
const styleEl = { dataset: {}, textContent: "" };
const sandbox = {
  window: fakeWindow,
  globalThis: undefined,
  location,
  document: {
    querySelector: () => null,
    createElement: () => ({ ...styleEl, dataset: {} }),
    head: { appendChild() {} }
  },
  URL,
  Map, Set, WeakMap, Promise, Symbol, Object, Number, String, Boolean, Array, Date, Error, RegExp, Math, JSON, isNaN, parseInt, parseFloat, clearInterval, setInterval, setTimeout,
  console
};
sandbox.globalThis = sandbox;
sandbox.window.location = location;
const react = new Proxy({}, { get: (t, k) => () => { throw new Error("react." + String(k) + " called at eval time"); } });
const fakeRequire = (name) => {
  if (name === "react") return react;
  if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: "F" };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return new Proxy({}, { get: (t, k) => k });
  if (name === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set() {} }), defineStore: () => ({}) };
  throw new Error("unexpected require: " + name);
};
sandbox.require = fakeRequire;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });
console.log("module id:", globalThis.__capturedId);
console.log("factory type:", typeof globalThis.__capturedFactory);
if (typeof globalThis.__capturedFactory !== "function") throw new Error("factory not captured");
const mod = { exports: {} };
const exported = globalThis.__capturedFactory(fakeRequire);

console.log("exports keys:", Object.keys(exported));
console.log("message listeners installed:", messageListeners.length);
if (messageListeners.length !== 1) throw new Error("expected exactly 1 window message listener");
// Drive the listener with a benign message: must not throw and must be ignored.
messageListeners[0]({ origin: "http://127.0.0.1:3080", data: { hello: 1 }, source: {} });
messageListeners[0]({ origin: "http://evil.example", data: { __dshInspectSelected: true }, source: {} });
messageListeners[0]({ origin: location.origin, data: { __dshInspectSelected: true, url: "http://x", selector: "#a", xpath: "/html", role: "button" }, source: {} });
console.log("benign + cross-origin + unmatched-source messages handled without throwing");
// With the relay announced, frame messages come from the relay origin; the GUI origin no longer qualifies.
sandbox.__DSH_LOOPBACK_RELAY__ = { port: 3090 };
messageListeners[0]({ origin: "http://127.0.0.1:3090", data: { __dshRelayAddress: "http://127.0.0.1:3090/dsh-loopback/http/localhost/5173/" }, source: {} });
messageListeners[0]({ origin: "http://127.0.0.1:3090", data: { __dshInspectReady: true, href: "http://127.0.0.1:3090/dsh-loopback/http/localhost/5173/" }, source: {} });
messageListeners[0]({ origin: location.origin, data: { __dshInspectSelected: true }, source: {} });
console.log("relay-origin address/ready messages handled without throwing");
console.log("SMOKE OK");
