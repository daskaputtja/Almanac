/** A neutral circle with a user's initials. Silo avatars need a per-user request, so we don't fetch them. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 2).toUpperCase() || '?';
  const sizes = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-16 w-16 text-xl' };
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-panel-raised font-semibold text-ink-muted ${sizes[size]}`}
    >
      {initials}
    </span>
  );
}

export function RoleBadges({ role, isOwner, enabled, inSilo }: { role: string | null; isOwner: boolean; enabled: boolean | null; inSilo: boolean }) {
  const badges: string[] = [];
  if (!inSilo) badges.push('Deleted');
  if (isOwner) badges.push('Owner');
  else if (role === 'admin') badges.push('Admin');
  if (enabled === false) badges.push('Disabled');
  return (
    <>
      {badges.map((b) => (
        <span key={b} className="rounded border border-line px-1.5 py-px text-[11px] font-medium text-ink-muted">
          {b}
        </span>
      ))}
    </>
  );
}
