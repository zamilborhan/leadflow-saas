export function formatBDT(minor: number): string {
  const major = minor / 100;
  return `৳${major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
