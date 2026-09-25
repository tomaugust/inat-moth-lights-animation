// Turns an observation's upload time into display text, shared by the
// side-panel cards (app.js) and the on-canvas hover pop-out
// (animation-engine.js) so the two can never disagree about a moth.
//
// The upload time (iNaturalist's created_at) is the only time this site uses:
// the live feed's order and pacing follow it, and it's the only one shown.
// The time the moth was actually photographed is deliberately ignored — a
// moth-light photographer typically uploads the next morning or days later,
// so it says nothing about when the sighting reached iNaturalist, and it's
// not part of the data this site keeps at all (see observation-adapter.js).

const TIME_FORMAT = { hour: "2-digit", minute: "2-digit" };

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "14:32" when it's today, otherwise the date is included ("13 Sep, 22:10",
// with the year added once it isn't this year) — a bare clock time with no
// date would make anything from an earlier day (the bundled fallback set, say)
// look like it just happened.
export function formatWhen(timestampMs, nowMs = Date.now()) {
  if (!Number.isFinite(timestampMs)) {
    return "";
  }
  const date = new Date(timestampMs);
  const now = new Date(nowMs);
  const time = date.toLocaleTimeString([], TIME_FORMAT);
  if (isSameLocalDay(date, now)) {
    return time;
  }
  const dateOptions = date.getFullYear() === now.getFullYear()
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" };
  return `${date.toLocaleDateString([], dateOptions)}, ${time}`;
}

// "Uploaded 14:32", or "" when the upload time is unknown.
export function formatUploadedTime(moth, nowMs = Date.now()) {
  const when = formatWhen(moth.createdAtMs, nowMs);
  return when ? `Uploaded ${when}` : "";
}
