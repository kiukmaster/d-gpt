import modelList from '../shared/chat-models.txt?raw';

export const supportedModelIds = modelList.trim().split(/\r?\n/);

export interface SchoolModel {
  id: string;
  provider: 'OpenAI' | 'Claude';
  image: '지원' | '미지원' | '확인 불가';
  imageSource?: 'provider';
  access: 'listed' | 'unconfirmed' | 'verified';
}

export function normalizeModels(catalog: { data: unknown[] }): SchoolModel[] {
  const allowed = new Map<string, SchoolModel>();
  const seen = new Set<string>();
  for (const entry of catalog.data) {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') continue;
    const id = entry.id;
    if (!supportedModelIds.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const provider = id.startsWith('claude-') ? 'Claude' : 'OpenAI';
    if ('model_type' in entry && ['embedding', 'image_generation', 'video_generation', 'transcription', 'speech'].includes(String(entry.model_type))) continue;
    const modalities = 'input_modalities' in entry ? entry.input_modalities : undefined;
    const known = Array.isArray(modalities) && modalities.length > 0 && modalities.every(value => typeof value === 'string' && value.trim().length > 0);
    const providerImage = !known && provider === 'Claude';
    const image = known ? (modalities.includes('image') ? '지원' : '미지원') : (providerImage ? '지원' : '확인 불가');
    allowed.set(id, { id, provider, image, access: 'listed', ...(providerImage && { imageSource: 'provider' }) });
  }
  for (const id of supportedModelIds) {
    if (!seen.has(id) && id.startsWith('claude-')) {
      allowed.set(id, { id, provider: 'Claude', image: '지원', imageSource: 'provider', access: 'unconfirmed' });
    }
  }
  return supportedModelIds.flatMap(id => allowed.get(id) ?? []);
}

export function resolveModel(models: readonly SchoolModel[], preferred: string | null): SchoolModel | null {
  return models.find(model => model.id === preferred) ?? models.find(model => model.access === 'listed') ?? models[0] ?? null;
}
