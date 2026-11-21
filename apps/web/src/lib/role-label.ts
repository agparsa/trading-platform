/** "PLATFORM_SUPER_ADMIN" as a person would say it: "Platform super admin". */
export function roleLabel(role: string): string {
  const words = role.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.length === 0 ? role : words.charAt(0).toUpperCase() + words.slice(1);
}
