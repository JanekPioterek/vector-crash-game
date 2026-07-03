// Minimal DOM shim to execute script.js headlessly and catch runtime errors.
const fs = require("fs");
const path = require("path");

function makeStyle() {
  const store = {};
  return new Proxy(
    { setProperty: (k, v) => { store[k] = v; } },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return store[prop];
      },
      set(target, prop, value) {
        store[prop] = value;
        return true;
      },
    }
  );
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      if (force === undefined) {
        if (set.has(name)) { set.delete(name); return false; }
        set.add(name); return true;
      }
      if (force) set.add(name); else set.delete(name);
      return force;
    },
    contains: (name) => set.has(name),
    _set: set,
  };
}

function make2DContext() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, arc: noop, ellipse: noop,
    stroke: noop, fill: noop, save: noop, restore: noop, translate: noop,
    rotate: noop, scale: noop, clip: noop, rect: noop,
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    set fillStyle(v) {}, get fillStyle() { return "#000"; },
    set strokeStyle(v) {}, get strokeStyle() { return "#000"; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineCap(v) {}, get lineCap() { return "butt"; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set shadowBlur(v) {}, get shadowBlur() { return 0; },
    set shadowColor(v) {}, get shadowColor() { return "#000"; },
    set font(v) {}, get font() { return "10px sans-serif"; },
  };
}

function makeElement(id) {
  const attrs = {};
  const el = {
    id,
    _attrs: attrs,
    classList: makeClassList(),
    style: makeStyle(),
    dataset: {},
    textContent: "",
    innerHTML: "",
    innerText: "",
    value: "10",
    disabled: false,
    hidden: false,
    checked: false,
    children: [],
    _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    click() { (el._listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(child) {
      if (child && child._isFragment) {
        for (const c of child.children) el.children.push(c);
        child.children.length = 0;
      } else {
        el.children.push(child);
      }
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    get firstChild() { return el.children.length ? el.children[0] : null; },
    contains: () => false,
    getBoundingClientRect: () => ({ width: 900, height: 520, top: 0, left: 0 }),
  };
  if (id === "tunnelCanvas") {
    el.width = 900;
    el.height = 520;
    el.getContext = () => make2DContext();
  }
  return el;
}

const elementRegistry = new Map();
function getOrCreateElement(id) {
  if (!elementRegistry.has(id)) elementRegistry.set(id, makeElement(id));
  return elementRegistry.get(id);
}

const chipEls = [10, 25, 50, 100].map((amt) => {
  const e = makeElement("chip-" + amt);
  e.dataset.amount = String(amt);
  return e;
});

let rafCallback = null;
let rafId = 0;

const documentStub = {
  readyState: "complete",
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: (id) => getOrCreateElement(id),
  querySelectorAll: (sel) => (sel === ".chip" ? chipEls : []),
  createElement: (tag) => makeElement("created-" + tag + "-" + Math.random()),
  createDocumentFragment: () => {
    const frag = {
      _isFragment: true,
      children: [],
      appendChild(child) { frag.children.push(child); return child; },
    };
    return frag;
  },
  activeElement: { tagName: "BODY" },
};

const windowStub = {
  addEventListener: () => {},
  removeEventListener: () => {},
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  requestAnimationFrame: (fn) => { rafCallback = fn; return ++rafId; },
  cancelAnimationFrame: () => {},
};

let clock = 0;
const performanceStub = { now: () => clock };

global.document = documentStub;
global.window = windowStub;
global.performance = performanceStub;
global.requestAnimationFrame = windowStub.requestAnimationFrame;
global.navigator = { userAgent: "node-test" };
global.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} arc() {} ellipse() {} rect() {}
};

const code = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

try {
  const fn = new Function(code + "\n//# sourceURL=script.js");
  fn();
  console.log("BOOT OK");
} catch (err) {
  console.log("BOOT THREW:", err.stack);
  process.exit(1);
}

// Drive the rAF loop for a simulated ~15 seconds (≈16ms per frame),
// placing a bet during countdown and cashing out mid-round to exercise the
// warp/trail code paths, not just passive idle rendering.
let frames = 0;
let crashedAt = null;
let betPlaced = false;
let cashedOut = false;
const mainBtn = elementRegistry.get("mainActionBtn");

for (let i = 0; i < 900; i++) {
  clock += 16;
  const cb = rafCallback;
  if (!cb) { console.log("No rAF callback captured after", frames, "frames"); break; }
  rafCallback = null;
  try {
    cb(clock);
    frames++;
    if (!betPlaced && clock > 500) {
      mainBtn.click(); // PLACE BET during countdown
      betPlaced = true;
    }
    if (!cashedOut && clock > 6000) {
      mainBtn.click(); // CASH OUT once the round is running
      cashedOut = true;
    }
  } catch (err) {
    crashedAt = { frame: frames, ms: clock, err };
    break;
  }
}
console.log("betPlaced:", betPlaced, "cashedOut:", cashedOut);

console.log("Frames executed:", frames, "of", 900);
if (crashedAt) {
  console.log("TICK THREW at frame", crashedAt.frame, "t=", crashedAt.ms, "ms");
  console.log(crashedAt.err.stack);
}

const liveBets = elementRegistry.get("liveBetsList");
console.log("\n--- liveBetsList rows (final):", liveBets ? liveBets.children.length : "(element not requested)", "---");
if (liveBets) {
  for (const row of liveBets.children) {
    const cells = row.children.map((c) => c.textContent).join(" | ");
    console.log(" ", row.className, "->", cells);
  }
}

const multiplierEl = elementRegistry.get("multiplierValue");
console.log("\nmultiplierValue.textContent:", multiplierEl ? multiplierEl.textContent : "(n/a)");

const modeLabelEl = elementRegistry.get("modeLabel");
console.log("modeLabel.textContent:", modeLabelEl ? modeLabelEl.textContent : "(n/a)");

process.exit(0); // the game's own setInterval heartbeat would otherwise keep this process alive forever
