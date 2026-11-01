let active = { copy: {} };
export function configureCopy(config) {
  active = config || { copy: {} };
}
class CopyValue {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}
export function C(key) {
  if (key instanceof CopyValue) return key;
  key = String(key);
  return new CopyValue(
    Object.hasOwn(active.copy || {}, key) ? active.copy[key] : key,
  );
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function H(key) {
  return escape(C(key));
}
export function M(markup) {
  return markup
    .replace(
      /((?:aria-label|placeholder|title)=")([^"]*)(")/g,
      (_, a, key, b) => a + escape(C(key)) + b,
    )
    .replace(/(^|>)([^<>]+)(?=<|$)/g, (_, prefix, part) => {
      const key = part.trim();
      return (
        prefix +
        (key && Object.hasOwn(active.copy || {}, key)
          ? part.replace(key, escape(C(key)))
          : part)
      );
    });
}
export function ui(strings, ...values) {
  return strings
    .map(
      (part, index) =>
        M(part) +
        (index < values.length
          ? values[index] instanceof CopyValue
            ? escape(values[index].value)
            : values[index]
          : ""),
    )
    .join("");
}
