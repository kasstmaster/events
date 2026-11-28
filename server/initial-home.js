import { earlyInteractionScript } from "./early-interaction-script.js";
import { familyHomeContent, familyHomeTopbar } from "../public/family-ui.js";
import {
  adminHomeContent,
  adminTopbar,
  button,
  eventPage,
  eventTopbar,
  homeTopbar,
  hostHomeContent,
  mainContent,
  pageHeader,
  pageToolbar,
  recipientAccessContent,
  recipientAccessTopbar,
} from "../public/first-paint.js";
import { configureCopy } from "../public/ui-runtime.js";
import { initialThemeStyle } from "./initial-theme.js";

export const initialHomeTopbar = (session = {}) =>
  homeTopbar(session.platformAdmin);
export const initialHomeBottomBar = () =>
  pageToolbar(null, { role: "host" }, true);

export function initialHomeHtml(data = {}) {
  if (!data.household)
    return '<section class="auth panel"><h1>Welcome to Gather</h1><p>Sign in to see your household and events.</p><a class="button" href="/signin">Sign in</a></section>';
  return hostHomeContent(data, true);
}

export function initialDocument(
  template,
  snapshot,
  { kind, data, session, event, reference } = {},
) {
  const config = event?.ui || data?.ui;
  const role = session?.role;
  configureCopy(config);
  try {
    let markup,
      navigation = "",
      layout = "";
    if (event) {
      navigation = eventTopbar(session);
      markup = eventPage(event, {
        role,
        hostOnly: data.hostOnly ?? snapshot.config?.hostOnly,
      });
      if (event.containerLayout !== "single") layout = "event";
    } else if (kind === "host") {
      navigation = initialHomeTopbar(session);
      markup = initialHomeHtml(data);
      layout = "hostHome";
    } else if (kind === "family") {
      navigation = familyHomeTopbar(data.member, data.preferences);
      markup = familyHomeContent(data, button);
    } else if (kind === "admin") {
      navigation = adminTopbar();
      markup = adminHomeContent(config?.layouts.introText);
    } else markup = initialHomeHtml();
    const recipientEntry = /^[A-Za-z0-9_-]{43}$/.test(reference || "")
      ? `<template id="gather-recipient-entry" data-reference="${reference}">${pageHeader({ navigation: recipientAccessTopbar() })}${mainContent(recipientAccessContent())}</template>`
      : "";
    const body =
      pageHeader({ role, event, navigation }) +
      mainContent(markup, !!kind, layout) +
      (kind ? pageToolbar(event, session, true) : "") +
      recipientEntry;
    // Script data is inert. Escape HTML delimiters before embedding raw text.
    const payload = JSON.stringify(snapshot).replaceAll("<", "\\u003c");
    return template
      .replace(/\s*<link\s[^>]*\bdata-gather-home\b[^>]*>/, "")
      .replace(
        "</head>",
        () =>
          (config ? initialThemeStyle(config.design, data.defaults) : "") +
          (kind ? `<script>${earlyInteractionScript}</script>` : "") +
          "</head>",
      )
      .replace(
        /<div id="app">[\s\S]*?<\/main>/,
        () =>
          (kind
            ? `<div id="app" data-page-chrome="${kind}" data-gather-initial="${kind}">`
            : '<div id="app">') + body,
      )
      .replace(
        "</body>",
        () =>
          `<script id="gather-public-event" type="application/json">${payload}</script></body>`,
      );
  } finally {
    configureCopy();
  }
}
