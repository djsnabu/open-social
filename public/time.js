export function wallTime(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const p = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Reject gaps and overlaps instead of silently changing the user's scheduled time.
export function toInstant(local, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('Enter a date and time.');
  const naive = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(naive)) throw new Error('Invalid date.');
  const offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = naive + hours * 3600000;
    offsets.add(Date.parse(`${wallTime(probe, timeZone)}:00Z`) - probe);
  }
  const matches = [...offsets].map(offset => naive - offset).filter(t => wallTime(t, timeZone) === local);
  if (matches.length !== 1) throw new Error(matches.length ? 'This time is ambiguous due to daylight saving time. Choose another time or the UTC time zone.' : 'This time does not exist in the selected time zone.');
  return new Date(matches[0]).toISOString();
}
