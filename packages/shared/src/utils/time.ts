function formatTimeDifference(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

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

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * A wall clock reading in the viewer's own timezone, as `14:32`.
 *
 * Assembled by hand rather than through `Intl`, because the strings these two
 * build sit in a fixed-height status strip: a locale that renders `2:32 PM`
 * changes the width of a line that is measured, and a test asserting the output
 * would be asserting whichever locale the machine running it happens to have.
 */
export function formatClockTime(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/**
 * The same clock reading with the day it fell on, as `12 Aug, 14:32`.
 *
 * The day is padded for the same reason the clock is: this string sits in a
 * fixed-height strip beside a monospaced run id, and an unpadded day would move
 * everything after it by a character on nine days in ten.
 */
export function formatDayAndTime(date: Date): string {
  const month = MONTH_NAMES[date.getMonth()];
  return `${twoDigits(date.getDate())} ${month}, ${formatClockTime(date)}`;
}
