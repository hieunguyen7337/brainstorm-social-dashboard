/**
 * Pulse Desktop: the confirmation before anything is really posted (docs/DESKTOP.md 4.6). Mounted once app-wide; shows
 * the main process's `PublishConfirmRequest` with the account, an editable caption and a photo picker (Instagram needs a
 * photo), then answers through `confirm.respond`. Closing the dialog is a cancel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Platform as RNPlatform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getDesktop, type PublishConfirmRequest } from '@/src/desktop';
import { pickScreenshot, type PickedImage } from '@/src/pickImage';
import { colors, platformMeta, radius, space, type as t } from '@/src/theme';
import { Button, TextField } from '@/src/ui';

export function PublishConfirmDialog() {
  const [req, setReq] = useState<PublishConfirmRequest | null>(null);
  const [caption, setCaption] = useState('');
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const current = useRef<PublishConfirmRequest | null>(null);
  current.current = req;

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    return desktop.confirm.onRequest((next) => {
      // A request still open is cancelled: the main process asks for one post at a time, so this is only a safety net.
      const old = current.current;
      if (old) void desktop.confirm.respond(old.id, { ok: false }).catch(() => undefined);
      setReq(next);
      setCaption(next.caption);
      setPhoto(null);
      setProblem(null);
      setSending(false);
    });
  }, []);

  const answer = useCallback(
    async (ok: boolean) => {
      const desktop = getDesktop();
      const open = current.current;
      if (!desktop || !open) return;
      setSending(true);
      try {
        await desktop.confirm.respond(
          open.id,
          ok && photo
            ? { ok: true, caption, imageBase64: photo.base64, mediaType: 'image/jpeg' }
            : { ok: false },
        );
      } catch {
        // the main process gave up on this request already
      }
      setReq(null);
      setPhoto(null);
      setSending(false);
    },
    [caption, photo],
  );

  const choose = () => {
    // Open the picker inside the press itself (see pickImage.web).
    const picked = pickScreenshot();
    setProblem(null);
    void picked.then((res) => {
      if (res.status === 'ok') setPhoto(res.image);
      else if (res.status === 'error') setProblem(res.message);
    });
  };

  if (!req) return null;
  const label = platformMeta[req.platform].label;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => void answer(false)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal testID="publish-confirm">
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={t.h2} accessibilityRole="header">{`Post to ${label}?`}</Text>
            <Text style={t.dim}>
              {req.handle ? `Posting as ${req.handle}. ` : ''}Nothing is posted until you press the button below.
            </Text>
            <TextField label="Caption" value={caption} onChangeText={setCaption} multiline editable={!sending} />
            <View style={styles.photoRow}>
              {photo ? (
                RNPlatform.OS === 'web' || photo.uri ? (
                  <Image source={{ uri: photo.uri }} style={styles.preview} resizeMode="cover" accessibilityLabel="Chosen photo" />
                ) : null
              ) : (
                <Text style={t.small}>{label} needs a photo (JPEG or PNG).</Text>
              )}
              <Button
                small
                variant="secondary"
                title={photo ? 'Choose another photo' : 'Choose a photo'}
                icon="image-outline"
                disabled={sending}
                onPress={choose}
              />
            </View>
            {problem ? (
              <Text style={[t.small, styles.problem]} accessibilityRole="alert">
                {problem}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button
                title={`Post to ${label}`}
                icon="paper-plane"
                disabled={!photo || sending}
                loading={sending}
                onPress={() => void answer(true)}
              />
              <Button variant="ghost" title="Cancel" disabled={sending} onPress={() => void answer(false)} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderHi,
  },
  content: { padding: space.lg, gap: space.md },
  photoRow: { gap: space.md, alignItems: 'flex-start' },
  preview: { width: 160, height: 160, borderRadius: radius.sm, backgroundColor: colors.cardHi },
  problem: { color: colors.danger },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
});
