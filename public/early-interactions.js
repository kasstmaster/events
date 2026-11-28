// This function is shared with the application and also emitted in the
// server-rendered document. Keep it independent of module scope.
export async function requestRecipientAccess(reference, householdID) {
  const response = await fetch("/api/public/events/" + reference + "/access", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ householdID }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to open RSVP.");
  return data;
}

// Runs before the first controls are parsed, even when the module download is
// slow. Full editors still use their existing handlers and authorization.
export function startEarlyInteractions(bindMenus, requestAccess) {
  bindMenus();
  let ready = false;
  let intent, recipient, submission;
  const reads = new Map();
  const feedback = (message) => {
    const notice = document.querySelector("#notice");
    if (notice) notice.textContent = message;
  };
  const clearIntent = () => {
    if (!intent) return;
    intent.removeAttribute("aria-busy");
    intent = null;
    reads.clear();
    feedback("");
  };
  function read(path) {
    if (reads.has(path)) return;
    // Speculative reads are scoped to the selected action and the same
    // server-validated session. The normal endpoint still authorizes them.
    reads.set(
      path,
      fetch(path, { credentials: "same-origin" }).catch(() => null),
    );
  }

  function openRecipient(target) {
    if (recipient) return;
    const template = document.querySelector("#gather-recipient-entry");
    if (!template) return;
    const [header, main] = [...template.content.cloneNode(true).children];
    const oldHeader = document.querySelector("#app > header");
    const oldMain = document.querySelector("#main");
    recipient = { oldHeader, oldMain, header, main, target };
    oldHeader.replaceWith(header);
    oldMain.replaceWith(main);
    main.querySelector("input").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function openInformation(trigger) {
    const dialog = document.querySelector("#editor");
    if (!dialog || dialog.open) return;
    dialog.classList.add("centered-popup");
    dialog.innerHTML =
      '<div class="dialog-head"><h2 id="dialog-title"></h2><button type="button" class="quiet" data-action="close" aria-label="Close editor">✕</button></div><div class="dialog-body"><p class="information-popup-content"></p></div>';
    dialog.querySelector("h2").textContent = trigger.textContent;
    dialog.querySelector(".information-popup-content").textContent =
      trigger.dataset.informationPopup;
    dialog.addEventListener(
      "close",
      () => {
        dialog.classList.remove("centered-popup");
        dialog.removeAttribute("data-early-popup");
        trigger.focus({ preventScroll: true });
      },
      { once: true },
    );
    dialog.setAttribute("data-early-popup", "");
    dialog.showModal();
  }

  document.addEventListener(
    "keydown",
    (event) => {
      const trigger = event.target.closest?.(
        "#app[data-gather-initial] [data-information-popup]",
      );
      if (ready || !trigger || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openInformation(trigger);
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (ready || event.defaultPrevented || event.button !== 0) return;
      const information = event.target.closest?.(
        "#app[data-gather-initial] [data-information-popup]",
      );
      const close = event.target.closest?.(
        "#editor[data-early-popup] [data-action=close]",
      );
      if (information || close) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (close) close.closest("dialog").close();
        else openInformation(information);
        return;
      }
      const target = event.target.closest?.("#app [data-action]");
      const page = target?.closest("[data-gather-initial]");
      if (!page || target.matches(":disabled,[aria-disabled=true]")) return;
      if (
        target.matches("a") &&
        (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      )
        return;
      const action = target.dataset.action;
      const kind = page.dataset.gatherInitial;
      event.preventDefault();
      event.stopImmediatePropagation();

      if (action === "print") {
        window.print();
        return;
      }
      if (recipient && action === "rsvp-cancel") {
        recipient.header.replaceWith(recipient.oldHeader);
        recipient.main.replaceWith(recipient.oldMain);
        recipient.target.focus({ preventScroll: true });
        recipient = null;
        submission = null;
        feedback("");
        return;
      }
      if (kind === "visitor" && action === "rsvp") {
        clearIntent();
        openRecipient(target);
        return;
      }
      if (action === "home" || action === "open-event") {
        clearIntent();
        const url = new URL("/", location.origin);
        if (action === "open-event")
          url.searchParams.set("event", target.dataset.id);
        if (["host", "family", "admin"].includes(kind) && action === "home") {
          window.scrollTo(0, 0);
        } else {
          location.assign(url);
        }
        return;
      }
      if (intent === target) return;
      clearIntent();
      intent = target;
      target.setAttribute("aria-busy", "true");
      const label =
        target.getAttribute("aria-label") || target.textContent.trim();
      feedback(label ? "Opening " + label + "…" : "Opening…");
      if (kind === "host" || kind === "host-event") {
        if (
          [
            "addresses",
            "cards",
            "new-event",
            "event-action-cards",
            "invite-guests",
            "rsvp",
            "event-pages-manage",
          ].includes(action)
        )
          read("/api/host/workspace");
        if (action === "family-workspace" || action === "settings")
          read("/api/family");
        if (action === "event-action-dashboard")
          read(
            "/api/host/events/" +
              encodeURIComponent(target.dataset.id) +
              "/dashboard",
          );
      }
      if (["cards", "event-action-cards", "global-defaults"].includes(action)) {
        const preload = document.createElement("link");
        preload.rel = "modulepreload";
        preload.href = "/editor-tools.js";
        document.head.append(preload);
      }
    },
    true,
  );

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (
        ready ||
        !recipient?.main.contains(form) ||
        form.dataset.form !== "recipient-access"
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (submission?.form === form) return;
      const reference = document.querySelector("#gather-recipient-entry")
        .dataset.reference;
      if (!/^[A-Za-z0-9_-]{43}$/.test(reference)) return;
      const buttons = [...form.querySelectorAll("button")];
      const error = form.querySelector(".form-error");
      error.textContent = "";
      buttons.forEach((button) => (button.disabled = true));
      form.dataset.saving = "true";
      feedback("Checking your Household ID…");
      const pending = {
        form,
        reset() {
          delete form.dataset.saving;
          buttons.forEach((button) => (button.disabled = false));
        },
        result: requestAccess(reference, new FormData(form).get("householdID")),
      };
      submission = pending;
      pending.result
        .then(() => {
          if (!ready && submission === pending) feedback("Opening your RSVP…");
        })
        .catch((problem) => {
          if (!ready && submission === pending && form.isConnected) {
            error.textContent = problem.message;
            feedback("");
            submission = null;
            pending.reset();
          }
        });
    },
    true,
  );

  window.addEventListener(
    "error",
    (event) => {
      if (
        ready ||
        !event.target?.matches?.(
          'script[src="/app.js"],script[src="/auth-bootstrap.js"]',
        )
      )
        return;
      clearIntent();
      feedback(
        "Gather couldn’t open this control. Reload the page to try again.",
      );
    },
    true,
  );

  window.gatherEarly = {
    claim() {
      ready = true;
      const current = { intent, recipient: !!recipient, submission };
      intent?.removeAttribute("aria-busy");
      intent = null;
      recipient = null;
      submission = null;
      return current;
    },
    takeRead(path) {
      const response = reads.get(path);
      reads.delete(path);
      return response;
    },
    clearReads() {
      reads.clear();
    },
  };
}
