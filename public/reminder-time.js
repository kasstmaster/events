function partsAt(instant, zone) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(
    values.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
}
export function localSchedule(instant, zone) {
  const p = partsAt(instant, zone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function utcSchedule(local, zone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new Error("Choose a valid reminder date and time.");
  const naive = Date.parse(local + "Z");
  let guess = naive;
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = partsAt(guess, zone),
      represented = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
      );
    const next = naive - (represented - guess);
    if (next === guess) break;
    guess = next;
  }
  if (localSchedule(guess, zone) !== local)
    throw new Error(
      "This local time does not exist because of a clock change. Choose another time.",
    );
  if (
    Array.from(
      { length: 24 },
      (_, i) => (i < 12 ? i - 12 : i - 11) * 15 * 60000,
    ).some((offset) => localSchedule(guess + offset, zone) === local)
  )
    throw new Error(
      "This local time occurs twice because of a clock change. Choose an unambiguous time.",
    );
  return new Date(guess).toISOString();
}
