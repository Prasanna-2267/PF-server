const formatters = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, value);
  }
  return value;
}

export function learnerDateKey(value: Date, timezone: string) {
  const parts = formatter(timezone).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error(`Unable to resolve learner date in ${timezone}.`);
  return `${year}-${month}-${day}`;
}

function dateTimeFormatter(timezone: string) {
  let value = dateTimeFormatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    });
    dateTimeFormatters.set(timezone, value);
  }
  return value;
}

/** Resolve local midnight to its exact UTC instant without assuming a fixed offset. */
export function learnerDayStartInstant(key: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("Invalid learner date.");
  const target = Date.parse(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(target)) throw new Error("Invalid learner date.");
  let instant = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = dateTimeFormatter(timezone).formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    const adjustment = target - represented;
    instant += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(instant);
}

export function databaseDate(key: string) {
  return new Date(`${key}T00:00:00.000Z`);
}

export function databaseDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function addLearnerDays(key: string, days: number) {
  const value = databaseDate(key);
  value.setUTCDate(value.getUTCDate() + days);
  return databaseDateKey(value);
}

export function monthBounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid learner month.");
  const start = databaseDate(`${month}-01`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return { start, end, days };
}

export function splitFocusSeconds(startedAt: Date, endedAt: Date, timezone: string, maximumSeconds = 86_400) {
  const rawSeconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  const creditedSeconds = Math.min(rawSeconds, maximumSeconds);
  const effectiveStart = new Date(endedAt.getTime() - creditedSeconds * 1000);
  const firstKey = learnerDateKey(effectiveStart, timezone);
  const lastKey = learnerDateKey(new Date(Math.max(effectiveStart.getTime(), endedAt.getTime() - 1)), timezone);
  if (firstKey === lastKey || creditedSeconds === 0) return [{ localDate: firstKey, seconds: creditedSeconds }];

  let low = effectiveStart.getTime();
  let high = endedAt.getTime();
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (learnerDateKey(new Date(middle), timezone) === firstKey) low = middle;
    else high = middle;
  }
  const firstSeconds = Math.max(0, Math.floor((high - effectiveStart.getTime()) / 1000));
  return [{ localDate: firstKey, seconds: firstSeconds }, { localDate: lastKey, seconds: creditedSeconds - firstSeconds }].filter((segment) => segment.seconds > 0);
}
