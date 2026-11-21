import { splitLinks } from './linkify';

describe('splitLinks', () => {
  it('returns plain text untouched', () => {
    expect(splitLinks('hello')).toEqual([{ text: 'hello' }]);
    expect(splitLinks('')).toEqual([]);
  });

  it('splits out a tracked link', () => {
    expect(splitLinks('Start here: https://pulse-hackathon.fly.dev/r/2gpw27\n\n#tag')).toEqual([
      { text: 'Start here: ' },
      { text: 'https://pulse-hackathon.fly.dev/r/2gpw27', url: 'https://pulse-hackathon.fly.dev/r/2gpw27' },
      { text: '\n\n#tag' },
    ]);
  });

  it('drops trailing punctuation and wrappers from the url', () => {
    const parts = splitLinks('(see https://a.example/r/ab12), ok.');
    expect(parts.filter((p) => p.url).map((p) => p.url)).toEqual(['https://a.example/r/ab12']);
    expect(parts.map((p) => p.text).join('')).toBe('(see https://a.example/r/ab12), ok.');
  });

  it('ignores non-http schemes', () => {
    expect(splitLinks('javascript:alert(1) ftp://x.y')).toEqual([{ text: 'javascript:alert(1) ftp://x.y' }]);
  });
});
