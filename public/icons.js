const paths = {
  sort: "M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4",
  invite:
    "M6 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0M3 21v-3a6 6 0 0 1 12 0v3M19 6v8m-4-4h8",
  uninvite: "M6 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0M3 21v-3a6 6 0 0 1 12 0v3M15 10h8",
  sync: "M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  moon: "M20 15a8 8 0 0 1-11-11 9 9 0 1 0 11 11Z",
  palette:
    "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3c-1-1 0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-9ZM7 9h.01M10 6h.01M15 7h.01M17 11h.01",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  more: "M12 4h.01M12 12h.01M12 20h.01",
  back: "M20 12H4m7-7-7 7 7 7",
  folder: "M3 6h7l2 3h9v12H3Z",
  list: "M5 3h14v18H5ZM8 7h8M8 12h8M8 17h8",
  task: "M4 4h16v16H4ZM7 12l3 3 7-7",
  settings:
    "M9 2h6l.5 3 2 1.2 2.8-1 2.2 3.8-2.3 2v2l2.3 2-2.2 3.8-2.8-1-2 1.2-.5 3H9l-.5-3-2-1.2-2.8 1L1.5 15l2.3-2v-2L1.5 9l2.2-3.8 2.8 1 2-1.2Z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  contacts: "M8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0M4 22v-3a8 8 0 0 1 16 0v3",
  child:
    "M9 6a3 3 0 1 0 6 0 3 3 0 0 0-6 0M12 9v7m-5-4 5-3 5 3m-5 4-4 6m4-6 4 6",
  hide: "M3 3l18 18M2 12c5-8 15-8 20 0-2 3-4 5-7 6M9 6c-3 1-5 3-7 6m7-2a4 4 0 0 0 5 5",

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
  const key = paths[action]
    ? action
    : action === "new-event"
      ? "plus"
      : action === "addresses"
        ? "contacts"
        : "edit";
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[key]}"/></svg>`;
}
