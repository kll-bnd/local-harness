// Prompt templates for internal tasks (summaries, memory extraction, titles) and context injection.

export const SUMMARY_SECTIONS = ['Goals', 'Key facts & context', 'Decisions', 'User preferences', 'Code & artifacts', 'Open threads'];

export function summarySystemPrompt(maxWords) {
  return [
    'You maintain a running summary of a long conversation between a user and an AI assistant. The summary replaces the older messages in the assistant\'s limited context window, so it must preserve everything needed to continue the conversation seamlessly.',
    '',
    'Update the existing summary with the new conversation span: keep all still-relevant information from the existing summary, merge in the new information, and drop details that were superseded. Be specific — keep names, numbers, dates, file names, code identifiers, URLs, decisions and their reasons. Use compact bullet points.',
    '',
    'Use exactly these Markdown sections (keep every heading; write "- (none)" if a section is empty):',
    ...SUMMARY_SECTIONS.map((s) => `## ${s}`),
    '',
    `Stay under ${maxWords} words. Output only the summary.`,
  ].join('\n');
}

export function summaryUserPrompt(existing, spanText) {
  return `<existing_summary>\n${existing?.trim() || '(none yet)'}\n</existing_summary>\n\n<conversation_span>\n${spanText}\n</conversation_span>\n\nWrite the updated summary.`;
}

export function chunkNotesSystemPrompt(maxWords) {
  return `You take notes on one part of a long conversation between a user and an AI assistant. Capture every important fact, decision, preference, request, code identifier, file name, number and open question as compact bullet points. Stay under ${maxWords} words. Output only the notes.`;
}

export function chunkNotesUserPrompt(chunkText, i, n) {
  return `<conversation_chunk part="${i}/${n}">\n${chunkText}\n</conversation_chunk>\n\nWrite the notes for this part.`;
}

export function mergeNotesUserPrompt(existing, notes) {
  const blocks = notes.map((n, i) => `<notes part="${i + 1}/${notes.length}">\n${n}\n</notes>`).join('\n\n');
  return `<existing_summary>\n${existing?.trim() || '(none yet)'}\n</existing_summary>\n\n<conversation_span>\nThe new span was too long to show verbatim; here are notes on it, in order:\n\n${blocks}\n</conversation_span>\n\nWrite the updated summary.`;
}

export const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update'] },
          id: { type: 'string' },
          content: { type: 'string' },
          category: { type: 'string', enum: ['fact', 'preference', 'project', 'instruction', 'other'] },
        },
        required: ['action', 'content'],
      },
    },
  },
  required: ['memories'],
};

export function memorySystemPrompt() {
  return [
    'You extract durable long-term memories about the USER from a conversation, for a personal assistant that remembers across conversations.',
    'Save only information that will still be useful weeks from now:',
    '- stable facts about the user (name, location, job, family, skills, equipment)',
    '- preferences (communication style, formats, tools, likes/dislikes)',
    '- ongoing projects and their key details',
    '- explicit requests to remember something, and standing instructions',
    'Do NOT save: one-off requests, the assistant\'s own statements, general knowledge, temporary states, secrets (passwords, API keys), or anything the user asked not to remember.',
    'Write each memory as one self-contained sentence in third person ("The user ...").',
    'If a new fact refines or contradicts an existing memory, use action "update" with that memory\'s id and the corrected sentence. Do not repeat memories that already exist unchanged.',
    'Respond with JSON only: {"memories":[{"action":"add"|"update","id":"<existing id, for update>","content":"...","category":"fact|preference|project|instruction|other"}]}. If nothing qualifies, respond {"memories":[]}.',
  ].join('\n');
}

export function memoryUserPrompt(existing, transcript) {
  const ex = existing.length ? existing.map((m) => `[${m.id}] ${m.content}`).join('\n') : '(none)';
  return `<existing_memories>\n${ex}\n</existing_memories>\n\n<conversation>\n${transcript}\n</conversation>\n\nExtract new or updated memories about the user as JSON.`;
}

export function titlePrompt(userText, assistantText) {
  return `Write a short, specific title (2-6 words) for a conversation that starts like this. Reply with the title only — no quotes, no trailing punctuation, no prefix.\n\nUser: ${userText}\n${assistantText ? `Assistant: ${assistantText}\n` : ''}`;
}

export function summaryBlock(summaryText) {
  return `## Summary of the earlier conversation\nThe earlier part of this conversation was condensed into the summary below; the original messages are no longer shown to you. Treat it as reliable context.\n<summary>\n${summaryText.trim()}\n</summary>`;
}

export function memoryBlock(memories, heading = '## What you know about the user (long-term memory)') {
  return `${heading}\n${memories.map((m) => `- ${m.content}`).join('\n')}`;
}

/** Ephemeral context prepended to the latest user message (keeps the cached prompt prefix stable). */
export function turnContextBlock({ memories = [], documents = [], recall = [] }) {
  const parts = [];
  if (memories.length) parts.push(`Memories about the user:\n${memories.map((m) => `- ${m.content}`).join('\n')}`);
  if (documents.length) parts.push(`Excerpts from attached documents:\n${documents.map((d) => `[${d.name}, part ${d.n + 1} of ${d.total}]\n${d.text}`).join('\n\n')}`);
  if (recall.length) parts.push(`Snippets from past conversations:\n${recall.map((r) => `[Chat "${r.chatTitle}", ${r.date}]\n${r.text}`).join('\n\n')}`);
  if (!parts.length) return '';
  return `<context>\nRetrieved automatically; it may or may not be relevant. Use it only if it helps.\n\n${parts.join('\n\n')}\n</context>\n\n`;
}
