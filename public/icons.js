const paths = {
  home: "M3 10 12 3l9 7v10h-6v-6H9v6H3Z",
  logout: "M9 4H4v16h5m5-16 7 8-7 8m-5-8h12",
  print: "M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6Z",
  rsvp: "M4 5h16v16H4ZM8 2v6m8-6v6M8 14l3 3 5-6",
  dashboard: "M4 20V10m8 10V4m8 16v-7",
  edit: "m4 16 12-12 4 4L8 20H4Z",
  plus: "M12 4v16M4 12h16",
  share: "M12 16V3m-5 5 5-5 5 5M5 13v8h14v-8",
};
export function icon(action) {
  const key =
    action === "dashboard"
      ? "dashboard"
      : action === "logout"
        ? "logout"
        : action === "rsvp"
          ? "rsvp"
          : action === "print"
            ? "print"
            : action === "home"
              ? "home"
              : action === "new-event"
                ? "plus"
                : action === "share"
                  ? "share"
                  : "edit";
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[key]}"/></svg>`;
}
