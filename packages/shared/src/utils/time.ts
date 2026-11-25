function formatTimeDifference(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

/**
 * How long ago `date` was, as "3 hours ago". This is the compact form every
 * list prints a time in, beside `formatExactTime` for a property value.
 */
export function getRelativeTime(date: string | Date): string {
  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return "just now";
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return formatTimeDifference(diffInMinutes, "min");
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return formatTimeDifference(diffInHours, "hour");
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) {
    return formatTimeDifference(diffInDays, "day");
  }

  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 4) {
    return formatTimeDifference(diffInWeeks, "week");
  }

  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) {
    return formatTimeDifference(diffInMonths, "month");
  }

  const diffInYears = Math.floor(diffInDays / 365);
  return formatTimeDifference(diffInYears, "year");
}

/**
 * The age of `date` in at most four characters, as `now`, `5m`, `14h`, `3d`,
 * `2w`, `4mo` or `1y`, for a list column of fixed width. It uses the same unit
 * steps as `getRelativeTime`. `now` is a parameter so a test can hold it still.
 */
export function getCompactRelativeTime(
  date: string | Date,
  now: Date = new Date()
): string {
  const diffInSeconds = Math.floor(
    (now.getTime() - new Date(date).getTime()) / 1000
  );
  if (diffInSeconds < 60) {
    return "now";
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}h`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) {
    return `${diffInDays}d`;
  }

  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 4) {
    return `${diffInWeeks}w`;
  }

  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) {
    return `${diffInMonths}mo`;
  }

  return `${Math.floor(diffInDays / 365)}y`;
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * A wall clock reading in the viewer's own timezone, as `14:32`.
 *
 * Assembled by hand rather than through `Intl`, because the strings this
 * module's clock formatters build sit in a fixed-height status strip: a
 * locale that renders `2:32 PM` changes the width of a line that is measured,
 * and a test asserting the output would be asserting whichever locale the
 * machine running it happens to have.
 */
export function formatClockTime(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/**
 * The same clock reading with seconds, as `14:32:05`, for an instant a person
 * compares against a ticking wait, such as when a run fell due.
 */
export function formatClockTimeWithSeconds(date: Date): string {
  return `${formatClockTime(date)}:${twoDigits(date.getSeconds())}`;
}

/**
 * An instant as the one exact form the editor prints in a property value, in
 * the viewer's locale and timezone, as "Nov 23, 1:05 PM". The year appears
 * when it differs from the year of `now`, as "Nov 23, 2025, 1:05 PM".
 */
export function formatExactTime(date: Date, now: Date = new Date()): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
