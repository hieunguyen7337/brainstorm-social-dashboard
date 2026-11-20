import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Post } from '@/src/api';
import { fmtInt, hashtagsText, parseHashtags } from '@/src/format';
import { platformMeta, space } from '@/src/theme';
import { Button, TextField } from '@/src/ui';

/** `PostCreate.content` max_length on the API. */
const MAX_CONTENT = 5000;

/**
 * Inline editor for a draft. It copies the post into local state once, when it mounts, so a 5 s poll that
 * brings the same post back never overwrites what the user is typing.
 */
export function PostEditor({
  post,
  saving,
  onSave,
  onCancel,
}: {
  post: Post;
  saving: boolean;
  onSave: (content: string, hashtags: string[]) => void;
  onCancel: () => void;
}) {
  const original = post.content ?? '';
  const [text, setText] = useState(original);
  const [tags, setTags] = useState(hashtagsText(post.hashtags ?? []));
  const meta = platformMeta[post.platform];

  const content = text.trim();
  const hashtags = parseHashtags(tags);
  const unchanged =
    content === original.trim() && hashtags.join(' ') === parseHashtags((post.hashtags ?? []).join(' ')).join(' ');
  const empty = content.length === 0;
  const over = text.length > meta.maxChars;

  const error = empty
    ? 'Write something first.'
    : over
      ? `Over the ${meta.label} guide of ${fmtInt(meta.maxChars)} characters (${fmtInt(text.length)}).`
      : null;

  return (
    <View style={styles.wrap}>
      <TextField
        label="Post text"
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        maxLength={MAX_CONTENT}
        editable={!saving}
        error={error}
        hint={`${fmtInt(text.length)} / ${fmtInt(meta.maxChars)} characters`}
        inputStyle={styles.input}
      />
      <TextField
        label="Hashtags"
        value={tags}
        onChangeText={setTags}
        editable={!saving}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="#launch #coffee"
        hint="Separate with spaces or commas."
      />
      <View style={styles.row}>
        <Button
          title="Save"
          icon="checkmark"
          small
          loading={saving}
          disabled={empty || unchanged}
          onPress={() => onSave(content, hashtags)}
        />
        <Button title="Cancel" variant="secondary" small disabled={saving} onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  input: { minHeight: 140, maxHeight: 320 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
