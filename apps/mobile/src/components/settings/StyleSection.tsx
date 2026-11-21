import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api, ApiError } from '@/src/api';
import { PICK_DOCUMENTS, pickFiles } from '@/src/pickFiles';
import { MAX_FILES, batchFiles, leftOutNotes, mergePicked, nameList, type PickedFile } from '@/src/pickFiles.types';
import { useSession } from '@/src/session';
import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import type { StyleLearnRequest, StyleSkipped } from '@/src/types';
import { Badge, Button, Card, SectionHeader, SkeletonCard, TextField, confirm, useToast } from '@/src/ui';

const MAX_PASTE = 20000;

const sampleWord = (n: number): string => (n === 1 ? '1 sample' : `${n} samples`);
const charsWord = (n: number): string => (n >= 1000 ? `about ${Math.round(n / 1000)}k characters` : `${n} characters`);

/**
 * "Your writing style": the person chooses up to 100 files (or pastes text) and Claude learns how they write, so every
 * generated post sounds like them. The API reads at most 10 files per request, so the files are sent as batches one after
 * another; each batch refines the saved style and the card shows it as soon as it is saved.
 */
export function StyleSection() {
  const { workspace, setWorkspace } = useSession();
  const toast = useToast();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [text, setText] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  // The learn loop outlives renders: it reads the latest of these instead of the values it started with.
  const latest = useRef({ workspace, files });
  latest.current = { workspace, files };

  const style = workspace?.writing_style ?? null;
  const hasInput = files.length > 0 || text.trim().length > 0;

  const header = (
    <SectionHeader
      title="Your writing style"
      subtitle="Upload things you've written and Pulse learns how you write, so every post sounds like you."
    />
  );

  if (!workspace) {
    return (
      <View style={styles.section}>
        {header}
        <SkeletonCard lines={4} />
      </View>
    );
  }

  const choose = async () => {
    if (busy) return;
    const res = await pickFiles(); // first thing in the tap: iPhone Safari only opens a picker from a direct tap
    if (res.status === 'cancelled') return;
    if (res.status === 'unavailable') {
      setError('This version of the app cannot choose files. Open Pulse in your browser to upload them.');
      return;
    }
    if (res.status === 'error') {
      setError(res.message);
      return;
    }
    const merged = mergePicked(latest.current.files, res.files);
    setFiles(merged.files);
    setNotes(leftOutNotes(merged.rejected));
    setError(null);
  };

  const learn = async () => {
    if (busy || !hasInput) return;
    const queue = files;
    const pasted = text.trim();
    const batches = batchFiles(queue);
    const steps = Math.max(batches.length, pasted ? 1 : 0);
    const skipped: StyleSkipped[] = [];
    let done = 0; // files handled so far (learned from or skipped), in queue order
    let learned = 0; // batches that reached Claude and were saved
    let pastedDone = false;
    setBusy(true);
    setError(null);
    setNotes([]);
    try {
      for (let i = 0; i < steps; i++) {
        const batch = batches[i] ?? [];
        const body: StyleLearnRequest = { files: [], text: i === 0 ? pasted : '' };
        for (const f of batch) {
          try {
            body.files?.push({ name: f.name, media_type: f.mediaType, data_base64: await f.read() });
          } catch {
            skipped.push({ name: f.name, reason: "couldn't read the file" });
          }
        }
        if (!body.files?.length && !body.text) {
          done += batch.length;
          continue;
        }
        setProgress({
          done,
          total: queue.length,
          label:
            batches.length > 1
              ? `Learning from files ${done + 1}–${done + batch.length} of ${queue.length}…`
              : 'Reading your writing…',
        });
        try {
          const res = await api.learnStyle(body);
          learned += 1;
          if (i === 0 && pasted) pastedDone = true;
          skipped.push(...res.skipped);
          const ws = latest.current.workspace;
          if (ws) setWorkspace({ ...ws, writing_style: res.style });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 422) throw e;
          // Nothing readable in this batch (e.g. only scanned PDFs): note the files and carry on with the next batch.
          for (const f of body.files ?? []) skipped.push({ name: f.name, reason: 'no readable text found' });
          if (i === 0 && pasted) pastedDone = true;
        }
        done += batch.length;
      }
      setFiles([]);
      setText('');
      setPasteOpen(false);
      setNotes(leftOutNotes(skipped));
      toast.show(learned > 0 ? 'Writing style updated' : 'Nothing readable to learn from');
    } catch (e) {
      // Stopped: what was learned is saved. Keep the current batch and the rest selected so the person can try again.
      setFiles(queue.slice(done));
      if (pastedDone) setText('');
      setNotes(leftOutNotes(skipped));
      const reason = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
      setError(
        done > 0 ? `${reason} Learned from the first ${done} of ${queue.length} files; the rest are still selected.` : reason,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const forget = async () => {
    const ok = await confirm('Forget your writing style?', 'Pulse will go back to using only your brand voice.', 'Forget', true);
    if (!ok) return;
    try {
      await api.forgetStyle();
      const ws = latest.current.workspace;
      if (ws) setWorkspace({ ...ws, writing_style: null });
      toast.show('Writing style forgotten');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  const chooseTitle = PICK_DOCUMENTS ? (style ? 'Add more files' : 'Choose files') : 'Choose screenshots';
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 4;

  return (
    <View style={styles.section}>
      {header}
      <Card style={styles.card}>
        {style ? (
          <View style={styles.learned}>
            <Badge label="Learned" tone="success" icon="checkmark-circle" style={styles.self} />
            <Text style={t.body}>{style.summary}</Text>
            {style.traits.map((trait) => (
              <View key={trait} style={styles.bullet}>
                <Text style={styles.dot}>•</Text>
                <Text style={[t.small, styles.grow]}>{trait}</Text>
              </View>
            ))}
            {style.examples[0] ? <Text style={styles.quote}>“{style.examples[0]}”</Text> : null}
            <Text style={t.small}>
              Learned from {sampleWord(style.file_count)}, {charsWord(style.sample_chars)}.
            </Text>
          </View>
        ) : (
          <Text style={t.small}>
            {PICK_DOCUMENTS
              ? `Posts, blog drafts, newsletters, notes: up to ${MAX_FILES} files at a time. Text, Markdown, PDF, Word, or screenshots of your past posts.`
              : `Screenshots of your past posts, up to ${MAX_FILES} at a time, or paste some text. To upload PDF, Word or text files, open Pulse in your browser.`}
          </Text>
        )}

        {files.length > 0 ? (
          <View style={styles.selection}>
            <View style={styles.selectionText}>
              <Text style={t.body}>{files.length === 1 ? '1 file chosen' : `${files.length} files chosen`}</Text>
              <Text style={t.small} numberOfLines={2}>
                {nameList(files.map((f) => f.name), 4)}
              </Text>
            </View>
            {!busy ? <Button title="Clear" variant="ghost" small onPress={() => setFiles([])} /> : null}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            title={chooseTitle}
            icon={PICK_DOCUMENTS ? 'document-text-outline' : 'images-outline'}
            variant="secondary"
            disabled={busy}
            onPress={() => void choose()}
            style={styles.grow}
          />
          <Button
            title={pasteOpen ? 'Hide text' : 'Paste text'}
            icon="clipboard-outline"
            variant="ghost"
            disabled={busy}
            onPress={() => setPasteOpen((open) => !open)}
          />
        </View>

        {pasteOpen ? (
          <TextField
            label="Your writing"
            value={text}
            onChangeText={setText}
            placeholder="Paste a few posts, an email or a blog draft in your own words."
            maxLength={MAX_PASTE}
            multiline
            inputStyle={styles.multiline}
          />
        ) : null}

        {progress ? (
          <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={progress.label}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${pct}%` }]} />
            </View>
            <Text style={t.small}>{progress.label}</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.error} accessibilityRole="alert">
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {notes.length > 0 ? (
          <View style={styles.notes}>
            {notes.map((note) => (
              <Text key={note} style={t.small}>
                {note}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            title={busy ? 'Reading your writing…' : 'Learn my style'}
            icon="sparkles"
            onPress={() => void learn()}
            disabled={!hasInput}
            loading={busy}
            style={styles.grow}
          />
          {style && !busy ? <Button title="Forget" icon="trash-outline" variant="danger" onPress={() => void forget()} /> : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  card: { gap: space.lg },
  learned: { gap: space.sm },
  self: { alignSelf: 'flex-start' },
  bullet: { flexDirection: 'row', gap: space.sm },
  dot: { fontSize: 12.5, lineHeight: 17, color: colors.accent },
  quote: { fontSize: 14, lineHeight: 20, fontStyle: 'italic', color: colors.textDim },
  selection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardHi,
  },
  selectionText: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', gap: space.md },
  grow: { flex: 1 },
  multiline: { minHeight: 120 },
  progress: { gap: space.sm },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  notes: { gap: space.xs },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: withAlpha(colors.danger, 0.4),
    backgroundColor: withAlpha(colors.danger, 0.1),
  },
  errorText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: colors.danger },
});
