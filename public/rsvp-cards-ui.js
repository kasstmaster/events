import { ui, C, H } from "./ui-runtime.js";
import { topbar, tool } from "./browse-ui.js";
export function rsvpCardsUI({ state, api, button, escape, render, field }) {
  let eventId = "",
    cardId = "",
    cardDraft = null,
    copies = 1,
    items = [],
    selected = new Set(),
    returnView = "home";
  const event = () => state.data.events?.find((e) => e.id === eventId);
  function download(svg, index, extension) {
    const save = (blob) => {
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "Gather-RSVP-" + (index + 1) + "." + extension;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    if (extension === "svg")
      return save(new Blob([svg], { type: "image/svg+xml" }));
    const image = new Image();
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    return image.decode().then(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 420;
      canvas.getContext("2d").drawImage(image, 0, 0, 600, 420);
      canvas.toBlob((blob) => {
        if (blob) save(blob);
      }, "image/png");
    });
  }
  return {
    open(event, card) {
      eventId = event;
      cardId = typeof card === "string" ? card : card?.id || "";
      cardDraft = typeof card === "object" ? card : null;
      copies = Math.max(
        1,
        Math.min(
          50,
          Number(document.querySelector("[name=printQuantity]")?.value || 1),
        ),
      );
      items = [];
      selected = new Set(
        state.data.events.find((e) => e.id === event)?.invited || [],
      );
      returnView = state.view;
      state.view = "rsvp-cards";
      render();
    },
    page() {
      return ui`${topbar({ title: C("QR RSVP cards"), back: "rsvp-cards-close" })}<section class="panel"><p>Each selected household receives a separate RSVP enclosure. Its QR opens sign-in and never authenticates the person holding the card.</p><form data-form="rsvp-cards">${state.data.guests
        .filter((g) => event()?.invited.includes(g.id))
        .map(
          (g) =>
            ui`<label class="check"><input name="recipient" type="checkbox" value="${escape(g.id)}" ${selected.has(g.id) ? "checked" : ""}>${escape([g.first, ...(g.parent ? [] : [g.last, g.suffix])].filter(Boolean).join(" "))}</label>`,
        )
        .join(
          "",
        )}<p class="form-error" role="alert"></p><button>Generate RSVP cards</button></form>${field(H("Copies per recipient"), "enclosureCopies", copies, "number", 'min="1" max="50"')}${items.length ? button("rsvp-cards-print", H("Print invitations and RSVP cards")) + button("rsvp-cards-print-only", H("Print RSVP cards only")) : ""}<div class="grid">${items.map((item, index) => ui`<article class="panel"><h2>${escape(item.name)}</h2><div class="rsvp-enclosure-preview">${item.svg}</div>${button("rsvp-cards-svg", H("Download SVG"), `data-id="${index}"`)}${button("rsvp-cards-png", H("Download PNG"), `data-id="${index}"`)}</article>`).join("")}</div></section>`;
    },
    async submit(form) {
      selected = new Set(new FormData(form).getAll("recipient"));
      items = (
        await api("/api/host/events/" + eventId + "/rsvp-cards", {
          method: "POST",
          version: event().version,
          data: {
            guestIds: [...selected],
            card: cardId,
            cardDraft,
          },
        })
      ).cards;
      render();
    },
    async action(action, target) {
      if (action === "rsvp-cards-close") {
        state.view = returnView;
        render();
        return true;
      }
      if (action === "rsvp-cards-svg" || action === "rsvp-cards-png") {
        const index = Number(target.dataset.id);
        if (items[index])
          await download(
            items[index].svg,
            index,
            action.endsWith("svg") ? "svg" : "png",
          );
        return true;
      }
      if (["rsvp-cards-print", "rsvp-cards-print-only"].includes(action)) {
        copies = Math.max(
          1,
          Math.min(
            50,
            Math.floor(
              Number(
                document.querySelector("[name=enclosureCopies]")?.value ||
                  copies,
              ),
            ) || 1,
          ),
        );
        const frame = document.createElement("iframe");
        frame.className = "print-frame";
        document.body.append(frame);
        frame.contentDocument.open();
        frame.contentDocument.write(
          "<!doctype html><title>Gather RSVP cards</title><style>@page{margin:10mm}.pair{break-after:page;display:grid;justify-items:center;gap:8mm}.enclosure svg{width:100mm;max-width:100%;height:auto}.invitation svg{max-width:126mm;max-height:180mm}.pair:last-child{break-after:auto}</style>" +
            Array.from({ length: copies }, () => items)
              .flat()
              .map(
                (item) =>
                  '<section class="pair">' +
                  (action === "rsvp-cards-print" && item.invitation
                    ? '<div class="invitation">' +
                      item.invitation +
                      (item.publicInvitation
                        ? '</div></section><section class="pair">'
                        : "</div>")
                    : "") +
                  '<div class="enclosure">' +
                  item.svg +
                  "</div></section>",
              )
              .join(""),
        );
        frame.contentDocument.close();
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(() => frame.remove(), 60000);
        return true;
      }
      return false;
    },
  };
}
