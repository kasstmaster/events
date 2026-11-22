import { ui, C, H } from "./ui-runtime.js";
import { topbar } from "./browse-ui.js";
export function weddingImportUI({
  state,
  api,
  field,
  select,
  button,
  escape,
  render,
  notify,
  directory,
}) {
  let source = null,
    target = null,
    people = [],
    mapping = {},
    review = null;
  const password = () =>
    field(
      H("Current system administrator password"),
      "password",
      "",
      "password",
      'required autocomplete="current-password"',
    );
  return {
    page() {
      const hosts = directory();
      return ui`${topbar({ title: C("Wedding content import"), back: "page-back" })}<section class="panel"><p>Use a complete, owner-reviewed content export from the existing wedding. The checked-in snapshot does not include its member pages or responsibilities. This imports no guest accounts, guest list, RSVPs or old private access tokens.</p>${
        !source
          ? ui`<form data-form="wedding-import-targets">${select(
              H("Existing host household"),
              "household",
              hosts.map((h) => [h.household, h.name]),
              hosts[0]?.household || "",
            )}${select(
              H("Existing wedding event"),
              "event",
              hosts.flatMap((h) =>
                (h.events || []).map((e) => [e.id, h.name + " · " + e.title]),
              ),
              hosts[0]?.events?.[0]?.id || "",
            )}${field(H("Authoritative wedding content JSON"), "sourceFile", "", "file", 'required accept="application/json,.json"')}${password()}<p class="form-error" role="alert"></p><button>Load source and destination people</button></form>`
          : !review
            ? ui`<form data-form="wedding-import-review"><p>Map each source wedding-party member to one existing invited person or host-family member. Names never create or merge accounts.</p>${source.members?.map((person) => ui`<label data-wedding-source-member="${escape(person.sourceID)}">${escape(person.name || person.sourceID)}<select>${people.map((p) => ui`<option value="${escape(p.id)}" ${mapping[person.sourceID] === p.id ? "selected" : ""}>${escape([p.first, p.last, p.suffix].filter(Boolean).join(" "))}</option>`).join("")}</select></label>`).join("") || ""}${password()}<p class="form-error" role="alert"></p><button>Review exact content import</button></form>`
            : ui`<h2>${escape(review.existingEvent.title)}</h2><p>${review.pages.length} pages · ${review.members} mapped members</p><ul>${review.pages.map((p) => ui`<li>${escape(p.title)} · ${escape(p.audience)}</li>`).join("")}</ul><form data-form="wedding-import-apply"><label class="check"><input type="checkbox" name="confirmAuthoritativeSource" required>I verified this is the complete current wedding content and reviewed the member mappings.</label>${field(H("Type IMPORT REVIEWED WEDDING CONTENT"), "confirm", "", "text", "required")}${password()}<p class="form-error" role="alert"></p><button>Import reviewed content</button>${button("wedding-import-revise", H("Revise mapping"))}</form>`
      }</section>`;
    },
    async action(action) {
      if (action === "wedding-import-open") {
        source = null;
        review = null;
        target = null;
        state.view = "admin-wedding-import";
        render();
        return true;
      }
      if (action === "wedding-import-revise") {
        review = null;
        render();
        return true;
      }
      return false;
    },
    async submit(form) {
      const kind = form.dataset.form,
        values = Object.fromEntries(new FormData(form));
      if (!kind.startsWith("wedding-import-")) return false;
      if (kind === "wedding-import-targets") {
        const file = form.elements.sourceFile.files[0];
        if (!file || file.size > 6000000)
          throw Error("Choose a wedding content JSON file below 6 MB.");
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          throw Error("Choose a valid wedding content JSON export.");
        }
        if (
          parsed?.repository !== "kasstmaster/themeyersgatherings" ||
          parsed.authoritative !== true ||
          !Array.isArray(parsed.members) ||
          !Array.isArray(parsed.pages)
        )
          throw Error(
            "A complete authoritative wedding content export is required; the checked-in app-state snapshot is incomplete.",
          );
        target = { household: values.household, event: values.event };
        people = (
          await api("/api/admin/wedding-import", {
            method: "POST",
            data: {
              ...target,
              password: values.password,
              operation: "targets",
            },
          })
        ).people;
        source = parsed;
        mapping = {};
      }
      if (kind === "wedding-import-review") {
        mapping = Object.fromEntries(
          [...form.querySelectorAll("[data-wedding-source-member]")].map(
            (row) => [
              row.dataset.weddingSourceMember,
              row.querySelector("select").value,
            ],
          ),
        );
        review = await api("/api/admin/wedding-import", {
          method: "POST",
          data: {
            ...target,
            password: values.password,
            source,
            memberMapping: mapping,
          },
        });
      }
      if (kind === "wedding-import-apply") {
        if (
          !confirm(
            "Import the reviewed content into this existing event? Guest lists, accounts and RSVPs will not be imported.",
          )
        )
          return true;
        await api("/api/admin/wedding-import", {
          method: "POST",
          data: {
            ...target,
            password: values.password,
            source,
            memberMapping: mapping,
            operation: "apply",
            reviewFingerprint: review.reviewFingerprint,
            confirm: values.confirm,
            confirmAuthoritativeSource: new FormData(form).has(
              "confirmAuthoritativeSource",
            ),
          },
        });
        source = null;
        review = null;
        state.view = "admin-hosts";
        notify(
          "Wedding content imported. Private access links must be shared manually.",
        );
      }
      form.elements.password.value = "";
      render();
      return true;
    },
  };
}
