import { bioLinkSteps, pickBioLink } from './bioLink';

const post = (p: Record<string, unknown>) =>
  ({ platform: 'instagram', status: 'published', link_url: 'https://x/r/a', published_at: '2026-11-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', ...p }) as Parameters<typeof pickBioLink>[0][number];

describe('pickBioLink', () => {
  it('returns null with no published Instagram post that has a link', () => {
    expect(pickBioLink([])).toBeNull();
    expect(pickBioLink([post({ status: 'draft' }), post({ platform: 'x' }), post({ link_url: null })])).toBeNull();
  });
  it('takes the newest published Instagram link', () => {
    const list = [post({ link_url: 'old' }), post({ link_url: 'new', published_at: '2026-11-10T00:00:00Z' }), post({ platform: 'tiktok', link_url: 'tt', published_at: '2026-12-01T00:00:00Z' })];
    expect(pickBioLink(list)).toBe('new');
  });
});

describe('bioLinkSteps', () => {
  it('says where to paste and that Pulse does not edit the bio', () => {
    expect(bioLinkSteps(true)).toContain('Link copied.');
    expect(bioLinkSteps(true)).toContain('Edit profile → Links → Add external link → paste');
    expect(bioLinkSteps(false)).toContain("Couldn't copy");
    expect(bioLinkSteps(true)).toContain('does not change your bio');
  });
});
