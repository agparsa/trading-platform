/**
 * A decimal string with its whole part grouped in threes: "100000.00" →
 * "100,000.00". Done on the string, never through a float, so the figure
 * shown is exactly the server's.
 */
export function groupDigits(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value.trim());
  if (match === null) return value;
  const [, sign = '', whole = '', fraction = ''] = match;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
}
