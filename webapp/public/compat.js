// Polyfills for older TV browsers (LG webOS 5 runs Chromium 68). Imported first by app.js.

if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function replaceChildren(...nodes) {
    while (this.lastChild) this.removeChild(this.lastChild);
    this.append(...nodes);
  };
}

if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true,
    writable: true,
    value: function flat(depth = 1) {
      return this.reduce((acc, v) => acc.concat(Array.isArray(v) && depth > 0 ? v.flat(depth - 1) : v), []);
    },
  });
}
