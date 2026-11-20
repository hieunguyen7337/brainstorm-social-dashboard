import { Button, EmptyState } from '@/src/ui';
import type { QueueTab } from './queueModel';

/** Per-tab empty state. Always says what to do next. */
export function EmptyQueue({
  tab,
  hasDrafts,
  onCreate,
  onGoDrafts,
}: {
  tab: QueueTab;
  /** Drafts exist, so the Published empty state can point at them instead of at Create. */
  hasDrafts: boolean;
  onCreate: () => void;
  onGoDrafts: () => void;
}) {
  if (tab === 'published') {
    return (
      <EmptyState
        icon="rocket-outline"
        title="Nothing published yet"
        message="Publish a draft to see it here, then watch the numbers grow."
        action={
          hasDrafts ? (
            <Button title="Go to drafts" variant="secondary" small onPress={onGoDrafts} />
          ) : (
            <Button title="Create posts" icon="sparkles" small onPress={onCreate} />
          )
        }
      />
    );
  }
  if (tab === 'scheduled') {
    return (
      <EmptyState
        icon="calendar-outline"
        title="Nothing scheduled"
        message="Schedule a draft and it will wait here until it goes out."
        action={<Button title="Create posts" icon="sparkles" onPress={onCreate} />}
      />
    );
  }
  return (
    <EmptyState
      icon="document-text-outline"
      title="No drafts yet"
      message="Generate a post for every platform in one go, then review it here."
      action={<Button title="Create posts" icon="sparkles" onPress={onCreate} />}
    />
  );
}
