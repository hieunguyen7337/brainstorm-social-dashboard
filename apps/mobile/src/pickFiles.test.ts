import {
  BATCH_BYTES,
  BATCH_FILES,
  MAX_FILES,
  MAX_FILE_BYTES,
  batchFiles,
  fileKind,
  leftOutNotes,
  mergePicked,
  nameList,
  type PickedFile,
} from './pickFiles.types';

const MB = 1024 * 1024;

function file(name: string, size = 1000, type = ''): PickedFile {
  return { id: name, name, size, kind: fileKind(name, type), mediaType: type, read: async () => '' };
}

describe('fileKind', () => {
  it('goes by the extension, whatever case', () => {
    expect(fileKind('post.md')).toBe('text');
    expect(fileKind('Notes.TXT')).toBe('text');
    expect(fileKind('essay.markdown')).toBe('text');
    expect(fileKind('Report.PDF')).toBe('pdf');
    expect(fileKind('letter.docx')).toBe('docx');
    expect(fileKind('shot.PNG')).toBe('image');
    expect(fileKind('a.jpg')).toBe('image');
    expect(fileKind('a.jpeg')).toBe('image');
    expect(fileKind('a.webp')).toBe('image');
  });

  it('falls back to the type when the extension says nothing (browsers guess types badly)', () => {
    expect(fileKind('README', 'text/plain')).toBe('text');
    expect(fileKind('scan', 'application/pdf; charset=binary')).toBe('pdf');
    expect(fileKind('photo', 'image/jpeg')).toBe('image');
    expect(fileKind('doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
  });

  it('refuses what Pulse cannot read', () => {
    expect(fileKind('data.csv', 'text/csv')).toBeNull();
    expect(fileKind('old.doc', 'application/msword')).toBeNull();
    expect(fileKind('movie.mp4', 'video/mp4')).toBeNull();
    expect(fileKind('noextension')).toBeNull();
    expect(fileKind('')).toBeNull();
  });

  it('never mistakes an extension for a property of Object', () => {
    expect(fileKind('x.constructor')).toBeNull();
    expect(fileKind('x.__proto__')).toBeNull();
    expect(fileKind('x.toString')).toBeNull();
  });
});

describe('mergePicked', () => {
  it('adds readable files in order', () => {
    const out = mergePicked([], [file('a.md'), file('b.pdf')]);
    expect(out.files.map((f) => f.name)).toEqual(['a.md', 'b.pdf']);
    expect(out.rejected).toEqual([]);
  });

  it('leaves out and reports files it cannot use', () => {
    const out = mergePicked([], [file('ok.md'), file('data.csv'), file('empty.txt', 0), file('huge.pdf', MAX_FILE_BYTES + 1)]);
    expect(out.files.map((f) => f.name)).toEqual(['ok.md']);
    expect(out.rejected).toEqual([
      { name: 'data.csv', reason: "this type isn't supported" },
      { name: 'empty.txt', reason: 'the file is empty' },
      { name: 'huge.pdf', reason: 'over 5 MB' },
    ]);
  });

  it('accepts a file of exactly 5 MB', () => {
    expect(mergePicked([], [file('edge.pdf', MAX_FILE_BYTES)]).files).toHaveLength(1);
  });

  it('quietly ignores a file that is already chosen (same name and size)', () => {
    const first = mergePicked([], [file('a.md', 10)]);
    const again = mergePicked(first.files, [file('a.md', 10), file('a.md', 11)]);
    expect(again.files.map((f) => `${f.name}:${f.size}`)).toEqual(['a.md:10', 'a.md:11']);
    expect(again.rejected).toEqual([]);
  });

  it('stops at 100 files and reports the rest', () => {
    const many = Array.from({ length: 105 }, (_, i) => file(`f${i}.md`));
    const out = mergePicked([], many);
    expect(out.files).toHaveLength(MAX_FILES);
    expect(out.rejected).toHaveLength(5);
    expect(out.rejected[0]).toEqual({ name: 'f100.md', reason: 'over the 100-file limit' });
    const more = mergePicked(out.files, [file('late.md')]);
    expect(more.files).toHaveLength(MAX_FILES);
    expect(more.rejected).toHaveLength(1);
  });

  it('does not change the list it was given', () => {
    const current = [file('a.md')];
    mergePicked(current, [file('b.md')]);
    expect(current).toHaveLength(1);
  });
});

describe('batchFiles', () => {
  it('turns 100 small files into 10 batches of 10', () => {
    const batches = batchFiles(Array.from({ length: 100 }, (_, i) => file(`f${i}.md`)));
    expect(batches).toHaveLength(10);
    expect(batches.every((b) => b.length === BATCH_FILES)).toBe(true);
  });

  it('keeps the order of the files', () => {
    const files = Array.from({ length: 25 }, (_, i) => file(`f${i}.md`));
    expect(batchFiles(files).flat().map((f) => f.name)).toEqual(files.map((f) => f.name));
    expect(batchFiles(files).map((b) => b.length)).toEqual([10, 10, 5]);
  });

  it('starts a new batch before one goes over the byte limit', () => {
    const files = [file('a.pdf', 5 * MB), file('b.pdf', 5 * MB), file('c.pdf', 5 * MB), file('d.pdf', 5 * MB)];
    const batches = batchFiles(files);
    expect(batches.map((b) => b.map((f) => f.name))).toEqual([['a.pdf', 'b.pdf'], ['c.pdf', 'd.pdf']]);
    for (const batch of batches) expect(batch.reduce((n, f) => n + f.size, 0)).toBeLessThanOrEqual(BATCH_BYTES);
  });

  it('handles none, one, and a file that fills a batch alone', () => {
    expect(batchFiles([])).toEqual([]);
    expect(batchFiles([file('a.md')])).toHaveLength(1);
    expect(batchFiles([file('a.pdf', 5 * MB), file('b.md', 100)]).map((b) => b.length)).toEqual([2]);
  });

  it('never sends more than the API takes in one request', () => {
    const sizes = [5 * MB, 1, 4 * MB, 5 * MB, 300, 3 * MB, 5 * MB, 5 * MB, 2 * MB];
    for (const batch of batchFiles(sizes.map((s, i) => file(`f${i}.pdf`, s)))) {
      expect(batch.length).toBeLessThanOrEqual(BATCH_FILES);
      expect(batch.reduce((n, f) => n + f.size, 0)).toBeLessThanOrEqual(15 * MB);
    }
  });
});

describe('notes about left-out files', () => {
  it('nameList shortens a long list', () => {
    expect(nameList(['a', 'b'])).toBe('a, b');
    expect(nameList(['a', 'b', 'c'])).toBe('a, b, c');
    expect(nameList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(nameList(['a', 'b', 'c', 'd', 'e'], 4)).toBe('a, b, c, d and 1 more');
  });

  it('leftOutNotes groups by reason', () => {
    expect(
      leftOutNotes([
        { name: 'a.csv', reason: "this type isn't supported" },
        { name: 'b.pdf', reason: 'over 5 MB' },
        { name: 'c.csv', reason: "this type isn't supported" },
      ]),
    ).toEqual(["2 files left out (this type isn't supported): a.csv, c.csv", '1 file left out (over 5 MB): b.pdf']);
    expect(leftOutNotes([])).toEqual([]);
  });
});
