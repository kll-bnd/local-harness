// Map API error codes to sentences a person can act on, plus the one action that most likely fixes it.
import { toast } from './ui/overlays.js';
import { runAction } from './actions.js';
import { store, ollamaStatus } from './state.js';

/** → { title, detail, action?: {label, run} } */
export function explainError(err, context = '') {
  const code = err?.code || 'unknown';
  const msg = err?.message || String(err);
  const ollama = ollamaStatus();
  switch (code) {
    case 'connection_failed': {
      const installed = ollama.process?.installed;
      return {
        title: /ollama/i.test(msg) || !msg ? "Ollama isn't running" : "The model server isn't running",
        detail: installed ? 'Harness can start it for you.' : msg,
        action: installed ? { label: 'Start Ollama', run: () => runAction('start-ollama') } : { label: 'Open setup', run: () => runAction('open-setup') },
      };
    }
    case 'no_model':
      return { title: 'No chat model is installed', detail: 'Download a model to start chatting — Harness suggests one that fits this Mac.', action: { label: 'Choose a model', run: () => runAction('open-setup') } };
    case 'model_load_failed': {
      const steps = err.details?.nextSteps || err.nextSteps || [];
      const first = steps.find((s) => s.action !== 'retry');
      return {
        title: "The model couldn't start",
        detail: msg,
        action: first ? { label: first.action === 'create_text_only_copy' ? 'Make a text-only copy' : first.action === 'use_smaller_file' ? 'Use a smaller file' : 'Try again', run: () => import('./next-steps.js').then((m) => m.runNextStep(first)) } : { label: 'Models', run: () => runAction('open-models') },
      };
    }
    case 'message_deleted':
      return { title: 'That message was deleted', detail: 'It was removed (perhaps in another window) before the reply could start. The chat has been refreshed.' };
    case 'registry_unreachable':
      return { title: "Can't reach the model registry", detail: 'Downloading needs an internet connection. Everything already installed keeps working offline.' };
    case 'workflow_invalid':
      return { title: 'ComfyUI rejected the workflow', detail: msg, action: { label: 'Image settings', run: () => runAction('open-settings', 'images') } };
    case 'name_taken':
      return { title: 'That name is already taken', detail: msg };
    case 'not_multimodal':
      return { title: 'This model is already text-only', detail: msg };
    case 'secret_detected':
      return { title: 'That looks like a password or key', detail: msg };
    case 'memory_protected':
      return { title: 'That memory is protected', detail: msg };
    case 'model_not_found':
      return { title: "That model isn't installed", detail: msg, action: { label: 'Open Models', run: () => runAction('open-models') } };
    case 'provider_not_found':
      return { title: "That model server isn't configured", detail: msg, action: { label: 'Providers', run: () => runAction('open-settings', 'providers') } };
    case 'chat_busy':
      return { title: 'This chat is still replying', detail: 'Wait for it to finish, or stop it first.', action: { label: 'Stop', run: () => runAction('stop-generation') } };
    case 'image_disabled':
      return { title: 'Image generation is turned off', detail: 'Turn it on in Settings → Image generation.', action: { label: 'Open settings', run: () => runAction('open-settings', 'images') } };
    case 'no_image_provider':
    case 'image_provider_unreachable':
      return { title: "Draw Things isn't reachable", detail: "In Draw Things, open Settings → API Server and turn on the HTTP server (port 7860). Harness will pick it up automatically.", action: { label: 'Image setup', run: () => runAction('open-setup') } };
    case 'image_provider_not_found':
      return { title: "That image backend isn't configured", detail: msg, action: { label: 'Image settings', run: () => runAction('open-settings', 'images') } };
    case 'provider_error':
      return { title: 'The model server returned an error', detail: msg };
    case 'timeout':
      return { title: 'The model took too long to respond', detail: 'On a small machine the first reply after loading can be slow. Try again.' };
    case 'start_timeout':
      return { title: "Ollama didn't start in time", detail: (err.details?.logTail || []).slice(-3).join('\n') || msg, action: { label: 'Try again', run: () => runAction('start-ollama') } };
    case 'not_installed':
      return { title: "Ollama isn't installed", detail: 'Install it from ollama.com, then come back — Harness will start it automatically.', action: { label: 'Setup', run: () => runAction('open-setup') } };
    case 'payload_too_large':
      return { title: 'That file is too large', detail: 'Attachments can be up to 50 MB.' };
    case 'attachment_unusable':
    case 'attachment_not_found':
      return { title: "That attachment can't be used", detail: msg };
    case 'nothing_to_compact':
      return { title: 'Nothing to summarize yet', detail: 'The conversation is still short enough to send in full.' };
    case 'no_summary':
      return { title: 'No summary yet', detail: msg };
    case 'read_only':
      return { title: "Built-in presets can't be changed", detail: 'Duplicate it to make your own version.' };
    case 'network':
    case 'stream_interrupted':
      return { title: "Can't reach Harness", detail: 'The app may have restarted. Reconnecting…' };
    case 'forbidden':
      return { title: 'Request blocked', detail: msg };
    case 'bad_request':
      return { title: context ? `Couldn't ${context}` : 'That didn\'t work', detail: msg };
    case 'not_found':
      return { title: 'Not found', detail: msg };
    case 'aborted':
      return { title: 'Stopped', detail: null };
    default:
      return { title: context ? `Couldn't ${context}` : 'Something went wrong', detail: msg };
  }
}

/** Show an error toast with its suggested action. */
export function showError(err, context = '') {
  if (err?.name === 'AbortError') return;
  console.warn('[harness]', context, err);
  if ((err?.code === 'network' || err?.code === 'stream_interrupted') && store.get('connection') !== 'online') return; // the banner covers it
  const x = explainError(err, context);
  toast({ kind: 'error', message: x.title, detail: x.detail, action: x.action, id: `err-${err?.code || 'x'}` });
}
