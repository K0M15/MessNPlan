import { DateTime } from 'luxon';

/** ISO-Wert → datetime-local-Wert in der Projekt-Zeitzone. */
export function toZoneInput(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone);
  return dt.isValid ? dt.toFormat("yyyy-MM-dd'T'HH:mm") : '';
}

/** datetime-local-Wert (Projekt-Zeitzone) → ISO-UTC-String. */
export function fromZoneInput(value: string, timezone: string): string | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: timezone });
  return dt.isValid ? (dt.toUTC().toISO({ suppressMilliseconds: true }) ?? null) : null;
}

export function formatDateTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '–';
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone);
  return dt.isValid ? dt.toFormat('dd.MM.yy HH:mm') : '–';
}

export function formatDate(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '–';
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone);
  return dt.isValid ? dt.toFormat('dd.MM.yy') : '–';
}

/** Reines Kalenderdatum (YYYY-MM-DD) ohne Zeitzonen-Umrechnung anzeigen. */
export function formatCalendarDate(date: string | null | undefined): string {
  if (!date) return '–';
  const dt = DateTime.fromISO(date);
  return dt.isValid ? dt.toFormat('dd.MM.yy') : '–';
}
