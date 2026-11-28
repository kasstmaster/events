import { designProperties } from "../public/page-theme.js";

export function initialThemeStyle(design, defaults) {
  return `<style id="gather-initial-theme">:root{${Object.entries(
    designProperties(design, defaults),
  )
    .map(([key, value]) => `${key}:${value}`)
    .join(";")}}</style>`;
}
