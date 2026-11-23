import { useModeration } from '../lib/moderation';

/** A user's tags as small chips, shown next to their name for admins and mods. */
export function UserTags({ userId, className = '' }: { userId: string; className?: string }) {
  const { tagsFor } = useModeration();
  const tags = tagsFor(userId);
  if (!tags.length) return null;
  return (
    <span className={`inline-flex flex-wrap gap-1 align-middle ${className}`}>
      {tags.map((t) => (
        <span key={t} className="rounded-full border border-harvest-dim/60 bg-harvest/10 px-1.5 py-px text-[10px] font-medium leading-4 text-ink">
          {t}
        </span>
      ))}
    </span>
  );
}
