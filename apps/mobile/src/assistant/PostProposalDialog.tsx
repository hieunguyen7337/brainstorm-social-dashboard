/**
 * The confirm dialog for a post Claude proposed (phone). Shows the caption (editable) and a photo picker with Instagram's
 * limits; nothing leaves the phone until the person presses the button. The hand-off reuses the Create and Queue device
 * paths (`src/igPost`): share sheet with the photo, the Instagram app, or (Android, behind IG_AUTOPOST) the signed-in WebView.
 * Closing the dialog is a cancel.
 */
import { useState } from 'react';
import { Image, Modal, Platform as RNPlatform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { canSharePhoto, openInstagramApp, pickPostPhoto, sharePhoto, type PostPhoto } from '@/src/igPost/device';
import { IgPostSheet, igAutoPostAvailable, type IgPostOutcome } from '@/src/igPost/IgPostSheet';
import { IG_AUTOPOST, IG_MAX_BYTES, IG_MIN_SIDE, igFailureText } from '@/src/igPost/logic';
import { colors, radius, space, type as t } from '@/src/theme';
import { Button, TextField, copyText } from '@/src/ui';

import { confirmLabel, handoffRoute } from './post';
import { MAX_CAPTION, type PostOutcome, type PostProposal } from './tools';

interface Props {
  proposal: PostProposal;
  onDone: (outcome: PostOutcome) => void;
}

export function PostProposalDialog({ proposal, onDone }: Props) {
  const [caption, setCaption] = useState(proposal.caption);
  const [photo, setPhoto] = useState<PostPhoto | null>(null);
  const [noPicker, setNoPicker] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);

  const route = handoffRoute({
    os: RNPlatform.OS,
    autopost: IG_AUTOPOST,
    autopostAvailable: igAutoPostAvailable(),
    canShare: canSharePhoto(),
    hasPhoto: photo !== null,
  });
  const text = caption.trim();
  const tooLong = text.length > MAX_CAPTION;
  const ready = !!text && !tooLong && (photo !== null || noPicker) && !busy;

  const choose = async () => {
    setProblem(null);
    const res = await pickPostPhoto();
    if (res.status === 'ok') setPhoto(res.photo);
    else if (res.status === 'unavailable') setNoPicker(true);
    else if (res.status === 'error') setProblem(res.message);
  };

  const confirm = async () => {
    if (!ready) return;
    setBusy(true);
    await copyText(text); // the caption is pasted by the person on the share / open-app routes
    if (route === 'autopost') {
      setSheet(true);
      return;
    }
    if (route === 'share' && photo && (await sharePhoto(photo.uri))) {
      onDone({ status: 'shared', caption: text });
      return;
    }
    onDone((await openInstagramApp()) ? { status: 'shared', caption: text } : { status: 'failed', message: "Couldn't open Instagram." });
  };

  const sheetDone = (out: IgPostOutcome) => {
    if (out.ok === true) onDone({ status: 'posted', caption: text, url: out.url });
    else if (out.ok === false) onDone({ status: 'failed', message: igFailureText(out) });
    else if (out.whilePosting) onDone({ status: 'failed', message: 'Closed while posting. It may have posted: check Instagram.' });
    else onDone({ status: 'cancelled' });
  };

  if (sheet && photo) return <IgPostSheet photo={photo} caption={text} onDone={sheetDone} />;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => !busy && onDone({ status: 'cancelled' })}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal testID="assistant-post-confirm">
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={t.h2} accessibilityRole="header">
              Post to Instagram?
            </Text>
            <Text style={t.dim}>Claude wrote this caption. Edit it if you like. Nothing is posted until you press the button below.</Text>
            <TextField
              label="Caption"
              value={caption}
              onChangeText={setCaption}
              multiline
              editable={!busy}
              error={tooLong ? `Instagram captions are at most ${MAX_CAPTION} characters.` : null}
            />
            <View style={styles.photoRow}>
              {photo ? (
                <Image source={{ uri: photo.uri }} style={styles.preview} resizeMode="cover" accessibilityLabel="Chosen photo" />
              ) : (
                <Text style={t.small}>
                  {noPicker
                    ? "This version can't pick photos here: Instagram opens and you choose the photo there."
                    : `Choose a photo. Instagram needs 4:5 to 1.91:1, at least ${IG_MIN_SIDE}px and under ${IG_MAX_BYTES / 1_000_000} MB; Pulse crops it square.`}
                </Text>
              )}
              {!noPicker ? (
                <Button
                  small
                  variant="secondary"
                  title={photo ? 'Choose another photo' : 'Choose a photo'}
                  icon="image-outline"
                  disabled={busy}
                  onPress={() => void choose()}
                />
              ) : null}
            </View>
            {problem ? (
              <Text style={[t.small, styles.problem]} accessibilityRole="alert">
                {problem}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button title={confirmLabel(route)} icon="paper-plane" disabled={!ready} loading={busy} onPress={() => void confirm()} />
              <Button variant="ghost" title="Cancel" disabled={busy} onPress={() => onDone({ status: 'cancelled' })} />
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
