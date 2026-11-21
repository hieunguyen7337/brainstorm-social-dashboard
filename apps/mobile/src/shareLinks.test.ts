import { captionFor, IG_MAX_HASHTAGS } from './shareLinks';

const tags = Array.from({ length: 12 }, (_, i) => `#tag${i}`);

describe('captionFor', () => {
  it('keeps at most 5 hashtags on Instagram (it strips the # from the rest)', () => {
    const caption = captionFor({ platform: 'instagram', content: 'Fresh beans.', hashtags: tags });
    expect(caption.match(/#/g)).toHaveLength(IG_MAX_HASHTAGS);
    expect(caption).toContain('#tag4');
    expect(caption).not.toContain('#tag5');
  });

  it('keeps every hashtag on other networks and when the platform is not given', () => {
    expect(captionFor({ platform: 'linkedin', content: 'Hi.', hashtags: tags }).match(/#/g)).toHaveLength(12);
    expect(captionFor({ content: 'Hi.', hashtags: tags }).match(/#/g)).toHaveLength(12);
  });
});
