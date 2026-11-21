import { keyProblem, maskKey, normalizeKey } from './key';

// An obviously fake key of the right shape.
const FAKE = `sk-ant-api03-${'A1b2C3d4'.repeat(10)}WXYZ`;

describe('normalizeKey', () => {
  it('trims whitespace, newlines and wrapping quotes', () => {
    expect(normalizeKey(`  "${FAKE}"\n`)).toBe(FAKE);
  });
});

describe('keyProblem', () => {
  it('accepts a plausible key, with a paste artefact', () => {
    expect(keyProblem(FAKE)).toBeNull();
    expect(keyProblem(` ${FAKE}\n`)).toBeNull();
  });
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['wrong prefix', 'sk-proj-' + 'a'.repeat(60)],
    ['too short', 'sk-ant-abc'],
    ['inner space', `sk-ant-${'a'.repeat(30)} ${'b'.repeat(30)}`],
    ['odd characters', `sk-ant-${'a'.repeat(30)}!${'b'.repeat(30)}`],
    ['too long', `sk-ant-${'a'.repeat(400)}`],
  ])('rejects %s', (_why, v) => {
    expect(keyProblem(v)).toEqual(expect.any(String));
  });
});

describe('maskKey', () => {
  it('shows only the prefix and the last four characters', () => {
    const m = maskKey(FAKE);
    expect(m).toBe('sk-ant-…WXYZ');
    expect(m).not.toContain('api03');
  });
  it('shows nothing for a too-short value', () => {
    expect(maskKey('abc')).toBe('');
  });
});
