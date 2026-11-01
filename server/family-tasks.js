import { createHash } from "node:crypto";
import { id, fail, text } from "./model.js";
import { utcSchedule, localSchedule } from "../public/reminder-time.js";
import { canRead } from "./family-permissions.js";
export function choreInput(store, member, input, current = {}) {
  const assignees = input.assignees || [];
  const owner =
    store.one(
      "SELECT owner FROM family_owners WHERE household=?",
      member.household,
    )?.owner ||
    store.one(
      "SELECT id FROM users WHERE household=? AND role='host'",
      member.household,
    )?.id;
  if (
    !Array.isArray(assignees) ||
    !assignees.length ||
    new Set(assignees).size !== assignees.length ||
    assignees.some(
      (key) =>
        key !== owner &&
        !store.one(
          "SELECT id FROM family_members WHERE household=? AND id=? AND disabled=0",
          member.household,
          key,
        ),
    )
  )
    fail(400, "Assign at least one active family member.");
  const zone = text(
    input.timezone || store.household(member.household).timezone || "UTC",
    100,
  );
  let due = "";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    if (input.dueLocal) due = utcSchedule(input.dueLocal, zone);
  } catch (error) {
    fail(400, error.message);
  }
  const repeat = input.repeat || "none";
  if (!["none", "daily", "weekly", "monthly"].includes(repeat))
    fail(400, "Choose a supported recurrence.");
  const interval = Number(input.interval || 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365)
    fail(400, "Choose a recurrence interval from 1 to 365.");
  if (repeat !== "none" && !due)
    fail(400, "Repeating chores need a first due date.");
  if (!["shared", "each"].includes(input.completionMode || "each"))
    fail(400, "Choose shared or separate completion.");
  const reminderMinutes = Number(input.reminderMinutes ?? -1);
  if (![-1, 0, 15, 30, 60, 1440].includes(reminderMinutes))
    fail(400, "Choose a supported in-app reminder time.");
  return {
    assignees,
    timezone: zone,
    due,
    dueLocal: input.dueLocal || "",
    repeat,
    interval,
    completionMode: input.completionMode || "each",
    reminderMinutes,
    linkedRecord: input.linkedRecord ? text(input.linkedRecord, 100) : "",
    cancelled: input.cancelled === true,
  };
}
export function scheduleKey(chore) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        chore.dueLocal,
        chore.timezone,
        chore.repeat,
        chore.interval,
        chore.assignees,
        chore.completionMode,
      ]),
    )
    .digest("hex");
}
function nextDue(chore, local) {
  const date = new Date(local + "Z");
  if (chore.repeat === "monthly") {
    const day = Number(chore.dueLocal.slice(8, 10));
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + chore.interval);
    const end = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, end));
  } else
    date.setUTCDate(
      date.getUTCDate() + (chore.repeat === "weekly" ? 7 : 1) * chore.interval,
    );
  return date.toISOString().slice(0, 16);
}
export function materializeTasks(store, household, now = Date.now()) {
  let pending = false;
  for (const chore of store
    .list("family-record", household)
    .filter((r) => r.type === "chore" && !r.cancelled)) {
    const schedule = scheduleKey(chore),
      cursor = store.get("family-task-cursor", chore.id, household);
    for (const occurrence of store
      .list("family-occurrence", household)
      .filter(
        (o) => o.chore === chore.id && o.schedule !== schedule && !o.cancelled,
      ))
      store.put(
        "family-occurrence",
        occurrence.id,
        household,
        { ...occurrence, cancelled: true },
        occurrence.version,
      );
    let local =
        cursor?.schedule === schedule ? cursor.nextLocal : chore.dueLocal,
      iterations = 0;
    if (!chore.dueLocal) {
      const key = chore.id + ":" + schedule + ":manual";
      if (!store.get("family-occurrence", key, household))
        store.put("family-occurrence", key, household, {
          chore: chore.id,
          schedule,
          due: "",
          assignees: chore.assignees,
          completionMode: chore.completionMode,
          completed: {},
        });
      continue;
    }
    while (local && iterations++ < 100) {
      let due;
      try {
        due = utcSchedule(local, chore.timezone);
      } catch {
        local = nextDue(chore, local);
        continue;
      }
      if (Date.parse(due) > now + 7 * 86400000) {
        const future = chore.id + ":" + schedule + ":" + due;
        if (!store.get("family-occurrence", future, household))
          store.put("family-occurrence", future, household, {
            chore: chore.id,
            schedule,
            due,
            assignees: chore.assignees,
            completionMode: chore.completionMode,
            completed: {},
          });
        break;
      }
      const key = chore.id + ":" + schedule + ":" + due;
      if (!store.get("family-occurrence", key, household))
        store.put("family-occurrence", key, household, {
          chore: chore.id,
          schedule,
          due,
          assignees: chore.assignees,
          completionMode: chore.completionMode,
          completed: {},
        });
      local = chore.repeat === "none" ? "" : nextDue(chore, local);
    }
    if (iterations >= 100 && local && Date.parse(local + "Z") < now)
      pending = true;
    if (cursor?.schedule !== schedule || cursor.nextLocal !== local)
      store.put(
        "family-task-cursor",
        chore.id,
        household,
        { schedule, nextLocal: local, pending: iterations >= 100 },
        cursor?.version,
      );
  }
  return pending;
}
export function occurrenceComplete(occurrence, memberId) {
  return !!occurrence.completed?.[
    occurrence.completionMode === "shared" ? "shared" : memberId
  ];
}
export function notificationAllowed(store, member, notification) {
  if (notification.member !== member.id) return false;
  const occurrence = store.get(
      "family-occurrence",
      notification.occurrence,
      member.household,
    ),
    chore =
      occurrence &&
      store.get("family-record", occurrence.chore, member.household);
  return !!(
    chore &&
    !chore.cancelled &&
    !occurrence.cancelled &&
    occurrence.schedule === scheduleKey(chore) &&
    chore.assignees.includes(member.id) &&
    canRead(store, member, chore) &&
    !occurrenceComplete(occurrence, member.id)
  );
}
export function runFamilyReminders(store, now = Date.now(), onlyHousehold) {
  for (const row of onlyHousehold
    ? store.all(
        "SELECT id FROM records WHERE kind='household' AND id=?",
        onlyHousehold,
      )
    : store.all("SELECT id FROM records WHERE kind='household'")) {
    const household = row.id;
    if (
      store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        household,
      )
    )
      continue;
    store.transaction(() => {
      materializeTasks(store, household, now);
      for (const occurrence of store.list("family-occurrence", household)) {
        const chore = store.get("family-record", occurrence.chore, household);
        if (
          !chore ||
          chore.cancelled ||
          occurrence.cancelled ||
          occurrence.schedule !== scheduleKey(chore) ||
          !occurrence.due ||
          chore.reminderMinutes < 0 ||
          Date.parse(occurrence.due) - chore.reminderMinutes * 60000 > now
        )
          continue;
        for (const member of chore.assignees) {
          if (occurrenceComplete(occurrence, member)) continue;
          const account = store.one(
            "SELECT role,disabled FROM family_members WHERE id=? AND household=?",
            member,
            household,
          );
          if (account?.disabled) continue;
          const prefs =
            store.get("family-preferences", member, household) || {};
          if (prefs.notifications === false) continue;
          const hour = Number(
            localSchedule(now, prefs.timezone || chore.timezone).slice(11, 13),
          );
          const start = prefs.quietStart,
            end = prefs.quietEnd;
          if (
            start !== undefined &&
            end !== undefined &&
            start !== end &&
            (start < end
              ? hour >= start && hour < end
              : hour >= start || hour < end)
          )
            continue;
          const key = chore.id + ":" + occurrence.due + ":" + member;
          const existing = store.get("family-notification", key, household);
          if (existing && existing.occurrence !== occurrence.id)
            store.put(
              "family-notification",
              key,
              household,
              { ...existing, occurrence: occurrence.id },
              existing.version,
            );
          if (!existing)
            store.put("family-notification", key, household, {
              member,
              occurrence: occurrence.id,
              created: new Date(now).toISOString(),
              read: false,
              title: "A task is due",
            });
        }
      }
    });
  }
}
