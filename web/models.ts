export interface SchoolModel {
  id: string;
  provider: 'OpenAI' | 'Claude';
  image: '지원' | '미지원' | '확인 불가';
}

export function normalizeModels(catalog: { data: unknown[] }): SchoolModel[] {
  const allowed = new Map<string, SchoolModel>();
  for (const entry of catalog.data) {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') continue;
    const id = entry.id;
    const provider = /^(?:anthropic\/)?claude-/.test(id) ? 'Claude' : /^(?:openai\/)?(?:gpt-|o\d+(?:-|$))/.test(id) ? 'OpenAI' : null;
    if (!provider || allowed.has(id)) continue;
    if ('model_type' in entry && ['embedding', 'image_generation', 'video_generation', 'transcription', 'speech'].includes(String(entry.model_type))) continue;
    const modalities = 'input_modalities' in entry ? entry.input_modalities : undefined;
    const known = Array.isArray(modalities) && modalities.length > 0 && modalities.every(value => typeof value === 'string' && value.trim().length > 0);
    const image = known ? (modalities.includes('image') ? '지원' : '미지원') : '확인 불가';
    allowed.set(id, { id, provider, image });
  }
  return [...allowed.values()];
}

export function resolveModel(models: readonly SchoolModel[], preferred: string | null): SchoolModel | null {
  return models.find(model => model.id === preferred) ?? models[0] ?? null;
}
