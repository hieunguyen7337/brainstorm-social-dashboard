import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pickPhotos, type PickedImage } from '@/src/pickImage';
import { MAX_PHOTOS } from '@/src/pickImage.types';
import { colors, radius, space, type as t } from '@/src/theme';
import { Button } from '@/src/ui';

/**
 * Optional photos for Generate: choose one or several, see them as thumbnails, remove any. Claude looks at them while it
 * writes. The list lives in the Create screen; this only edits it.
 */
export function PhotoPicker({
  photos,
  onChange,
  disabled,
}: {
  photos: PickedImage[];
  onChange: (next: PickedImage[]) => void;
  disabled?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const full = photos.length >= MAX_PHOTOS;

  const add = async () => {
    // Open the picker inside the press itself (see pickImage.web).
    const res = await pickPhotos(MAX_PHOTOS - photos.length);
    if (res.status === 'ok') {
      onChange([...photos, ...res.images]);
      setNote(res.skipped > 0 ? `${res.skipped} photo${res.skipped === 1 ? ' was' : 's were'} skipped (unreadable or over the limit).` : null);
    } else if (res.status === 'error') {
      setNote(res.message);
    } else if (res.status === 'unavailable') {
      setNote("This build can't open photos.");
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={t.label}>Photos (optional)</Text>
        <Text style={styles.count} accessibilityLabel={`${photos.length} of ${MAX_PHOTOS} photos`}>
          {`${photos.length}/${MAX_PHOTOS}`}
        </Text>
      </View>

      {photos.length > 0 ? (
        <View style={styles.grid}>
          {photos.map((photo, i) => (
            <View key={`${i}-${photo.uri.slice(-24)}`} style={styles.thumbWrap}>
              <Image source={{ uri: photo.uri }} style={styles.thumb} resizeMode="cover" accessibilityLabel={`Photo ${i + 1}`} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${i + 1}`}
                disabled={disabled}
                onPress={() => {
                  onChange(photos.filter((_, j) => j !== i));
                  setNote(null);
                }}
                style={styles.remove}
              >
                <Ionicons name="close" size={14} color={colors.white} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          title={photos.length === 0 ? 'Add photos' : 'Add more'}
          icon="images-outline"
          variant="secondary"
          small
          disabled={disabled || full}
          onPress={() => void add()}
        />
        {photos.length > 0 ? <Button title="Clear" variant="ghost" small disabled={disabled} onPress={() => { onChange([]); setNote(null); }} /> : null}
      </View>

      <Text style={styles.hint}>
        {full ? `That's the most: ${MAX_PHOTOS} photos.` : 'Choose one photo or many. Claude uses them to write posts about what they show.'}
      </Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const THUMB = 76;

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { fontSize: 12, fontWeight: '600', color: colors.textMute, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  thumbWrap: { width: THUMB, height: THUMB },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.sm, backgroundColor: colors.border },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  hint: { fontSize: 12.5, color: colors.textMute },
  note: { fontSize: 12.5, color: colors.warn },
});
