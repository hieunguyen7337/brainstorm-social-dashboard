import { DEFAULT_MODEL, MODELS, modelOption, modelRequestOptions, resolveModel } from './models';

describe('models', () => {
  it('lists exactly the three models, Opus 5.5 first and the default', () => {
    expect(MODELS.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  it('resolves a known id and falls back to the default for anything else', () => {
    expect(resolveModel('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    for (const bad of ['claude-opus-4-1', 'claude-opus-5-5-20251101', '', null, undefined, 7, {}]) {
      expect(resolveModel(bad)).toBe(DEFAULT_MODEL);
    }
    expect(modelOption('nope').name).toBe('Claude Opus 5.5');
  });

  it('sends server-side fallbacks for Opus and Sonnet only', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(modelRequestOptions(id)).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    }
    const haiku = modelRequestOptions('claude-haiku-5-5');
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku).not.toHaveProperty('betas');
  });

  it('always thinks adaptively at medium effort and never forces a tool', () => {
    for (const m of MODELS) {
      const o = modelRequestOptions(m.id);
      expect(o).toMatchObject({ model: m.id, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
      expect(o).not.toHaveProperty('tool_choice');
    }
  });
});
