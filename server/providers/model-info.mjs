// Normalize per-provider model metadata into one ModelInfo shape (see docs/API.md "ModelInfo").
import { parseModelfileParameters } from './ollama.mjs';
import { profileFor, contextOverrideFor, EMBEDDING_NAME_RE } from './catalog.mjs';

function findKey(obj, suffix) {
  for (const [k, v] of Object.entries(obj || {})) if (k.endsWith(suffix)) return v;
  return undefined;
}

export function normalizeOllamaShow(model, show = {}, tag = null) {
  const mi = show.model_info || {};
  const archName = mi['general.architecture'] || show.details?.family || null;
  const g = (k) => (archName && mi[`${archName}.${k}`] !== undefined ? mi[`${archName}.${k}`] : findKey(mi, `.${k}`));
  const advertised = Number(g('context_length')) || null;
  const generalName = mi['general.name'] || mi['general.basename'] || null;
  const override = contextOverrideFor(model, generalName, mi['general.basename']);
  const profile = profileFor(model, generalName, archName);

  let caps = Array.isArray(show.capabilities) ? [...show.capabilities] : null;
  if (!caps) {
    caps = [];
    const tpl = show.template || '';
    const families = show.details?.families || [];
    const isEmbed = EMBEDDING_NAME_RE.test(model) || g('pooling_type') !== undefined;
    if (isEmbed) caps.push('embedding');
    else caps.push('completion');
    if (/\.Tools\b/.test(tpl)) caps.push('tools');
    if (/\.Think\b/.test(tpl)) caps.push('thinking');
    if (show.projector_info || families.includes('clip') || families.includes('mllama')) caps.push('vision');
  }

  const contextLength = override?.contextLength || advertised || null;
  return {
    model,
    displayName: generalName || model,
    sizeBytes: tag?.sizeBytes ?? null,
    digest: tag?.digest ?? null,
    family: show.details?.family || tag?.family || null,
    parameterSize: show.details?.parameter_size || tag?.parameterSize || null,
    quantization: show.details?.quantization_level || tag?.quantization || null,
    capabilities: caps,
    contextLength,
    contextLengthSource: override ? 'override' : advertised ? 'metadata' : 'unknown',
    advertisedContextLength: advertised,
    contextNote: override?.note || null,
    arch: {
      name: archName,
      blockCount: g('block_count') ?? null,
      embeddingLength: g('embedding_length') ?? null,
      headCount: g('attention.head_count') ?? null,
      headCountKv: g('attention.head_count_kv') ?? null,
      keyLength: g('attention.key_length') ?? null,
      valueLength: g('attention.value_length') ?? null,
      slidingWindow: g('attention.sliding_window') ?? null,
      slidingWindowPattern: g('attention.sliding_window_pattern') ?? null,
      sharedKvLayers: g('attention.shared_kv_layers') ?? null,
      parameterCount: mi['general.parameter_count'] ?? null,
    },
    modelfileParameters: parseModelfileParameters(show.parameters),
    profile: { id: profile.id, family: profile.family, sampling: profile.sampling || {}, imageTokens: profile.imageTokens || 576, swa: profile.swa || null, notes: profile.notes || null },
    serverContext: null,
  };
}

/** OpenAI-compatible servers expose little metadata; fill what we can. */
export function normalizeOpenAIModel(provider, entry, serverInfo = {}) {
  const lm = entry?._lm || serverInfo.models?.[entry?.model];
  const profile = profileFor(entry?.model, lm?.arch);
  const override = contextOverrideFor(entry?.model);
  const trained = entry?._meta?.n_ctx_train ?? lm?.maxContext ?? null;
  const serverCtx = serverInfo.nCtx ?? lm?.loadedContext ?? null;
  const caps = [];
  if (lm?.type === 'embeddings' || EMBEDDING_NAME_RE.test(entry?.model || '')) caps.push('embedding');
  else caps.push('completion', 'tools');
  if (lm?.type === 'vlm' || serverInfo.vision) caps.push('vision');
  return {
    model: entry?.model,
    displayName: entry?.model,
    sizeBytes: entry?.sizeBytes ?? null,
    digest: null,
    family: lm?.arch || profile.family,
    parameterSize: entry?.parameterSize ?? null,
    quantization: entry?.quantization ?? null,
    capabilities: caps,
    contextLength: override?.contextLength || trained || null,
    contextLengthSource: override ? 'override' : trained ? 'metadata' : 'unknown',
    advertisedContextLength: trained,
    contextNote: override?.note || null,
    arch: { name: lm?.arch || null },
    modelfileParameters: {},
    profile: { id: profile.id, family: profile.family, sampling: profile.sampling || {}, imageTokens: profile.imageTokens || 576, swa: profile.swa || null, notes: profile.notes || null },
    serverContext: serverCtx,
    capabilitiesKnown: !!lm || serverInfo.vision !== undefined,
  };
}
