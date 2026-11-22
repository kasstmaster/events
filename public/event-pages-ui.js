import { ui, C, H } from "./ui-runtime.js";
import { topbar, tool, row } from "./browse-ui.js";
import { renderInformation, readInformation } from "./event-information.js";
import { takeInvitationFragment } from "./auth-bootstrap.js";
export function eventPagesUI({
  state,
  api,
  field,
  button,
  select,
  escape,
  render,
  load,
  fileData,
  informationEditor,
  notify,
}) {
  let pending = takeInvitationFragment(),
    active = null,
    editing = null,
    catalog = null,
    grantURL = "",
    eventID = "";
  addEventListener("gather-invitation-fragment", () => {
    pending = takeInvitationFragment();
    load();
  });
  const event = () =>
    state.data?.events?.find((e) => e.id === eventID) ||
    state.data?.events?.find((e) => e.id === state.event);
  const names = (p) => [p.first, p.last, p.suffix].filter(Boolean).join(" ");
  const invited = () => [
    ...(state.data.hostFamily || []),
    ...(state.data.guests?.filter((p) => event()?.invited.includes(p.id)) ||
      []),
  ];
  return {
    async hydrate(data, reference) {
      if (pending) {
        state.visitor.privateGrant =
          new URLSearchParams(pending.slice(1)).get("private") || "";
        pending = "";
      }
      if (!state.visitor.privateGrant) return;
      try {
        const result = await api(`/api/public/events/${reference}/pages`, {
          method: "POST",
          data: { grant: state.visitor.privateGrant },
        });
        data.events[0].extraPages = result.pages;
        if (
          state.view === "event-extra-page" &&
          active &&
          !result.pages.some((p) => p.id === active.id)
        ) {
          active = null;
          state.view = "home";
        }
      } catch {
        state.visitor.privateGrant = "";
        active = null;
        state.view = "home";
        notify("Private page access is unavailable or has been revoked.");
      }
    },
    page() {
      if (state.view === "event-extra-page")
        return ui`${topbar({ title: escape(active.title), back: "page-back" })}<section class="panel"><h1>${escape(active.title)}</h1>${active.image ? ui`<img class="event-icon" src="${escape(active.image)}" alt="${escape(active.title)}">` : ""}<div data-host-content>${renderInformation(active.content)}</div></section>`;
      return ui`${topbar({ title: C("Event pages"), back: "page-back", extra: editing ? tool("event-page-save", "Save", "", "save") + tool("event-page-cancel", "Cancel", "", "close") : "" })}<section class="panel">${
        editing
          ? ui`<form data-form="event-page">${field(H("Page title"), "title", editing.title || "", "text", 'required maxlength="160"')}${select(
              H("Who can open this page?"),
              "audience",
              [
                ["public", C("Everyone with the event link")],
                ["roles", C("Assigned wedding-party roles")],
                ["members", C("Selected individual members")],
              ],
              editing.audience || "public",
            )}${field(H("Allowed roles · one per line"), "roles", (editing.roles || []).join(", "), "text")}${invited()
              .map(
                (p) =>
                  ui`<label class="check"><input type="checkbox" name="members" value="${escape(p.id)}" ${(editing.members || []).includes(p.id) ? "checked" : ""}>${escape(names(p))}</label>`,
              )
              .join(
                "",
              )}${informationEditor(editing.content || [])}${field(H("Page image"), "pageImage", "", "file", 'accept="image/png,image/jpeg,image/webp"')}${editing.image ? ui`<label class="check"><input type="checkbox" name="removeImage">Remove page image</label>` : ""}<p class="form-error" role="alert"></p><button>Save page</button>${editing.id ? button("event-page-archive", H("Archive page"), "", "danger") : ""}</form>`
          : ui`<ul class="browse-rows">${(catalog?.pages || []).map((p) => row({ title: escape(p.title), action: "event-page-edit", id: p.id, symbol: "edit" })).join("")}</ul>${button("event-page-new", H("Add event page"))}<h2>Individual private access</h2><p>Each person receives a separate revocable link. A Household ID does not open these pages.</p><form data-form="event-page-grant">${select(
              H("Invited member"),
              "guest",
              invited().map((p) => [p.id, names(p)]),
              invited()[0]?.id || "",
            )}${field(H("Assigned roles · comma separated"), "roles", "", "text")}<p class="form-error" role="alert"></p><button>Create private member link</button></form>${grantURL ? field(H("Share this private link manually"), "privatePageURL", grantURL, "text", "readonly") : ""}<ul class="browse-rows">${(
              catalog?.grants || []
            )
              .filter((g) => !g.revoked)
              .map((g) =>
                row({
                  title: escape(
                    names(
                      invited().find((p) => p.id === g.guest) || {
                        first: "Uninvited member",
                      },
                    ),
                  ),
                  action: "event-page-revoke",
                  id: g.id,
                  symbol: "close",
                }),
              )
              .join("")}</ul>`
      }</section>`;
    },
    async action(action, target) {
      if (action === "event-extra-page") {
        eventID = state.event;
        const e = event();
        if (state.session.role === "host") {
          catalog = await api(`/api/host/events/${e.id}/pages`);
          active = catalog.pages.find((p) => p.id === target.dataset.id);
        } else {
          active = (
            await api(
              `/api/public/events/${state.visitor.reference}/pages/${target.dataset.id}`,
              {
                method: "POST",
                data: { grant: state.visitor.privateGrant || undefined },
              },
            )
          ).page;
        }
        if (!active) throw Error("Page unavailable.");
        state.view = "event-extra-page";
        render();
        return true;
      }
      if (action === "event-pages-manage") {
        eventID = state.event;
        catalog = await api(`/api/host/events/${eventID}/pages`);
        editing = null;
        grantURL = "";
        state.view = "event-pages-manage";
        render();
        return true;
      }
      if (action === "event-page-new") {
        editing = {};
        render();
        return true;
      }
      if (action === "event-page-edit") {
        editing = catalog.pages.find((p) => p.id === target.dataset.id);
        render();
        return true;
      }
      if (action === "event-page-save") {
        document.querySelector('form[data-form="event-page"]').requestSubmit();
        return true;
      }
      if (action === "event-page-cancel") {
        editing = null;
        render();
        return true;
      }
      if (action === "event-page-archive") {
        if (
          !confirm(
            "Archive this page? Its saved history will be retained and guest access will close.",
          )
        )
          return true;
        await api(`/api/host/events/${eventID}/pages/${editing.id}`, {
          method: "DELETE",
          version: editing.version,
          data: { confirm: true },
        });
        editing = null;
        catalog = await api(`/api/host/events/${eventID}/pages`);
        render();
        return true;
      }
      if (action === "event-page-revoke") {
        if (!confirm("Revoke this person's private page link?")) return true;
        const grant = catalog.grants.find((g) => g.id === target.dataset.id);
        await api(`/api/host/events/${eventID}/page-grants`, {
          method: "POST",
          data: { revoke: grant.id, version: grant.version, confirm: true },
        });
        catalog = await api(`/api/host/events/${eventID}/pages`);
        render();
        return true;
      }
      return false;
    },
    async submit(form) {
      const kind = form.dataset.form,
        values = Object.fromEntries(new FormData(form));
      if (kind === "event-page") {
        await api(
          `/api/host/events/${eventID}/pages` +
            (editing.id ? "/" + editing.id : ""),
          {
            method: editing.id ? "PUT" : "POST",
            version: editing.version,
            data: {
              title: values.title,
              audience: values.audience,
              roles: values.roles
                .split(/[,\n]/)
                .map((s) => s.trim())
                .filter(Boolean),
              members: new FormData(form).getAll("members"),
              content: readInformation(
                form.querySelector("[data-information-input]"),
              ),
              image: values.removeImage
                ? ""
                : (await fileData(form.elements.pageImage)) ||
                  editing.image ||
                  "",
            },
          },
        );
        editing = null;
        catalog = await api(`/api/host/events/${eventID}/pages`);
        render();
        return true;
      }
      if (kind === "event-page-grant") {
        const old = catalog.roles.find((r) => r.guest === values.guest);
        await api(`/api/host/events/${eventID}/page-roles`, {
          method: "POST",
          data: {
            guest: values.guest,
            version: old?.version || 0,
            roles: values.roles
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
          },
        });
        grantURL = (
          await api(`/api/host/events/${eventID}/page-grants`, {
            method: "POST",
            data: { guest: values.guest },
          })
        ).url;
        catalog = await api(`/api/host/events/${eventID}/pages`);
        render();
        return true;
      }
      return false;
    },
  };
}
