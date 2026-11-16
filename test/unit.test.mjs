import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../server/tools/calculate.mjs';
import { estimateTextTokens, Calibrator } from '../server/context/tokens.mjs';
import { ThinkTagParser, stripThinking } from '../server/chat/reasoning.mjs';
import { BM25Index, tokenize } from '../server/memory/bm25.mjs';
import { HybridIndex } from '../server/memory/hybrid.mjs';
import { normalize } from '../server/memory/vectors.mjs';
import { addMessage, pathTo, setActiveLeaf, deepestLeaf, deleteSubtree, siblings, turnUserMessage } from '../server/chat/tree.mjs';
import { newChat } from '../server/store/chats.mjs';
import { chunkText, processUpload } from '../server/docs/extract.mjs';
import { extractPdfText } from '../server/docs/pdf.mjs';
import { htmlToText } from '../server/lib/html.mjs';
import { isPrivateAddress, fetchUrl } from '../server/tools/fetch-url.mjs';
import { SETTINGS_SCHEMA } from '../server/store/settings.mjs';
import { validatePatch } from '../server/store/schema.mjs';
import { normalizeMessages } from '../server/context/assemble.mjs';
import { fillWorkflow, DEFAULT_TXT2IMG_WORKFLOW } from '../server/image/comfyui.mjs';
import { fakeEmbedding } from './fake-model.mjs';
import { tmpDir } from './helpers.mjs';
import { buildPdf } from './pdf-fixture.mjs';

describe('calculate (safe evaluator)', () => {
  test('arithmetic, precedence, functions, constants', () => {
    assert.equal(evaluate('1+2*3'), 7);
    assert.equal(evaluate('(1+2)*3'), 9);
    assert.equal(evaluate('2^3^2'), 512);
    assert.equal(evaluate('-2^2'), -4);
    assert.equal(evaluate('sqrt(16) + max(1, 5, 3)'), 9);
    assert.equal(evaluate('5!'), 120);
    assert.equal(evaluate('50%'), 0.5);
    assert.equal(evaluate('10 % 3'), 1);
    assert.equal(evaluate('round(pi, 2)'), 3.14);
    assert.equal(evaluate('2pi'), 2 * Math.PI);
    assert.equal(evaluate('1e3 / 4'), 250);
    assert.equal(evaluate('7 // 2'), 3);
    assert.ok(Math.abs(evaluate('sind(30)') - 0.5) < 1e-12);
  });
  test('rejects code and unknown identifiers', () => {
    for (const bad of ['process.exit()', 'constructor', '__proto__', 'toString()', 'a=1', '`x`', 'require("fs")', '1+', '']) {
      assert.throws(() => evaluate(bad), Error, bad);
    }
  });
});

describe('token estimator + calibration', () => {
  test('estimates are monotonic and in a sane range', () => {
    const en = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const n = estimateTextTokens(en);
    assert.ok(n > 150 && n < 300, `english estimate ${n}`);
    assert.ok(estimateTextTokens(en + en) > n);
    assert.ok(estimateTextTokens('你好世界'.repeat(10)) >= 40);
    assert.equal(estimateTextTokens(''), 0);
  });
  test('calibration converges to the observed ratio, ignores outliers, persists', async () => {
    const dir = await tmpDir();
    const cal = await new Calibrator(dir).load();
    for (let i = 0; i < 12; i++) cal.observe('ollama', 'm', { estimatedRaw: 1000, actual: 1400, numCtx: 8192 });
    assert.ok(Math.abs(cal.factor('ollama', 'm') - 1.4) < 0.02, `factor ${cal.factor('ollama', 'm')}`);
    // Truncated prompt (hit num_ctx) and absurd ratios are ignored.
    assert.equal(cal.observe('ollama', 'm', { estimatedRaw: 1000, actual: 8192, numCtx: 8192 }), null);
    assert.equal(cal.observe('ollama', 'm', { estimatedRaw: 1000, actual: 5, numCtx: 8192 }), null);
    assert.equal(cal.observe('ollama', 'm', { estimatedRaw: 1000, actual: 1400, numCtx: 8192, hasImages: true }), null);
    await cal.save();
    const again = await new Calibrator(dir).load();
    assert.ok(Math.abs(again.factor('ollama', 'm') - 1.4) < 0.02);
    assert.equal(again.factor('ollama', 'other'), 1);
    const counter = again.counter('ollama', 'm');
    assert.equal(counter.text('hello world'), Math.ceil(estimateTextTokens('hello world') * counter.factor));
  });
});

describe('reasoning: inline <think> parser', () => {
  test('splits tags across arbitrary chunk boundaries', () => {
    const full = 'pre <think>step one\nstep two</think>\n\nThe answer is 42.';
    for (const size of [1, 2, 3, 5, 8, 100]) {
      const p = new ThinkTagParser();
      const parts = [];
      for (let i = 0; i < full.length; i += size) parts.push(...p.push(full.slice(i, i + size)));
      parts.push(...p.end());
      const content = parts.filter((x) => x.type === 'content').map((x) => x.text).join('');
      const reasoning = parts.filter((x) => x.type === 'reasoning').map((x) => x.text).join('');
      assert.equal(reasoning, 'step one\nstep two', `size ${size}`);
      assert.equal(content, 'pre The answer is 42.', `size ${size}`);
    }
  });
  test('unterminated think block is reasoning; stripThinking cleans history', () => {
    const p = new ThinkTagParser();
    const parts = [...p.push('<thinking>still going'), ...p.end()];
    assert.deepEqual(parts.map((x) => x.type), ['reasoning']);
    assert.equal(stripThinking('<think>x</think>Answer'), 'Answer');
  });
});

describe('lexical + hybrid retrieval', () => {
  test('BM25 ranks relevant docs and supports removal', () => {
    const idx = new BM25Index();
    idx.add('a', 'The user prefers dark roast coffee in the morning');
    idx.add('b', 'Harness is a local LLM chat application');
    idx.add('c', 'The user lives in Lisbon, Portugal');
    assert.equal(idx.search('what coffee does the user like')[0].id, 'a');
    assert.equal(idx.search('where do I live? Lisbon')[0].id, 'c');
    idx.remove('a');
    assert.ok(!idx.search('coffee').length);
    assert.deepEqual(tokenize('The Running horses'), ['runn', 'horse']);
  });
  test('hybrid index combines semantic and lexical scores', async () => {
    const embedder = { resolve: async () => ({ ref: { model: 'fake' } }), embed: async (texts) => ({ model: 'fake', vectors: texts.map((t) => normalize(fakeEmbedding(t))) }) };
    const h = new HybridIndex({ embedder });
    h.upsert('1', 'User enjoys hiking in the mountains');
    h.upsert('2', 'User writes TypeScript at work');
    h.upsert('3', 'Grocery list: eggs, milk');
    assert.equal(await h.ensureEmbeddings(), 3);
    const q = (await embedder.embed(['mountains hiking trip'])).vectors[0];
    const res = h.search('mountains hiking trip', { k: 2, queryVector: { model: 'fake', vec: q }, minSimilarity: 0.3 });
    assert.equal(res[0].id, '1');
    assert.ok(res[0].semantic > 0.3);
    const lexOnly = h.search('TypeScript', { k: 3 });
    assert.equal(lexOnly[0].id, '2');
  });
});

describe('message tree (branching)', () => {
  const msg = (id, parentId, role = 'user', t = 0) => ({ id, parentId, role, content: id, createdAt: new Date(1700000000000 + t).toISOString() });
  test('paths, siblings, branch memory, delete subtree', () => {
    const c = newChat();
    addMessage(c, msg('u1', null, 'user', 1));
    addMessage(c, msg('a1', 'u1', 'assistant', 2));
    addMessage(c, msg('u2', 'a1', 'user', 3));
    addMessage(c, msg('a2', 'u2', 'assistant', 4));
    setActiveLeaf(c, 'a2');
    // regenerate a1 → sibling a1b
    addMessage(c, msg('a1b', 'u1', 'assistant', 5));
    setActiveLeaf(c, 'a1b');
    assert.deepEqual(pathTo(c, c.activeLeafId).map((m) => m.id), ['u1', 'a1b']);
    assert.deepEqual(siblings(c, 'a1').map((m) => m.id), ['a1', 'a1b']);
    // switching back to a1 restores the remembered deeper branch
    setActiveLeaf(c, deepestLeaf(c, 'a1'));
    assert.equal(c.activeLeafId, 'a2');
    // edit u2 → sibling u2b with its own reply
    addMessage(c, msg('u2b', 'a1', 'user', 6));
    addMessage(c, msg('a2b', 'u2b', 'assistant', 7));
    setActiveLeaf(c, 'a2b');
    assert.equal(turnUserMessage(c, 'a2b').id, 'u2b');
    setActiveLeaf(c, deepestLeaf(c, 'u2'));
    assert.equal(c.activeLeafId, 'a2');
    const deleted = deleteSubtree(c, 'u2');
    assert.deepEqual(deleted.sort(), ['a2', 'u2']);
    assert.equal(c.activeLeafId, 'a2b');
    assert.ok(!c.messages.u2 && !c.messages.a2);
  });
});

describe('message normalization (tool-pair integrity)', () => {
  test('drops orphan tool results and dangling tool calls, merges user turns, fixes leading role', () => {
    const out = normalizeMessages([
      { role: 'system', content: 's' },
      { role: 'tool', content: 'orphan', toolCallId: 'x' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculate', arguments: {} }] },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'ok', toolCalls: [{ id: 'c2', name: 't', arguments: {} }] },
      { role: 'tool', content: 'r2', toolCallId: 'c2' },
    ]);
    assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(out[1].content, 'a\n\nb');
    assert.equal(out[2].toolCalls.length, 1);
    const lead = normalizeMessages([{ role: 'system', content: 's' }, { role: 'assistant', content: 'hi' }]);
    assert.equal(lead[1].role, 'user');
  });
});

describe('documents', () => {
  test('chunker keeps all text with overlap and respects size', () => {
    const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(8)}`);
    const chunks = chunkText(paras.join('\n\n'), { targetTokens: 120, overlapTokens: 20 });
    assert.ok(chunks.length > 5);
    for (const c of chunks) assert.ok(c.tokens <= 160, `chunk tokens ${c.tokens}`);
    const all = chunks.map((c) => c.text).join('\n');
    for (let i = 0; i < 40; i++) assert.ok(all.includes(`Paragraph ${i}:`), `missing paragraph ${i}`);
  });

  test('PDF text extraction (FlateDecode + ToUnicode + object streams-free classic file)', () => {
    const pdf = buildPdf([
      'BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET',
      'BT /F1 12 Tf 72 700 Td [(Kerned) -300 (text)] TJ T* (Second line) Tj ET',
    ]);
    const r = extractPdfText(pdf);
    assert.equal(r.pages, 2);
    assert.match(r.text, /Hello PDF world/);
    assert.match(r.text, /Kerned text/);
    assert.match(r.text, /Second line/);
    const up = processUpload('doc.pdf', 'application/pdf', pdf);
    assert.equal(up.kind, 'text');
  });

  test('classifies uploads', () => {
    assert.equal(processUpload('a.py', null, Buffer.from('print("hi")\n')).kind, 'text');
    assert.equal(processUpload('x.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3, 0, 0, 7])).kind, 'binary');
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000080802000000', 'hex');
    const r = processUpload('p.png', null, png);
    assert.equal(r.kind, 'image');
    assert.equal(r.width, 16);
    assert.equal(r.height, 8);
  });

  test('html to text', () => {
    const { title, text } = htmlToText('<html><head><title>T &amp; T</title><style>x{}</style></head><body><nav>menu</nav><h1>Head</h1><p>Para &lt;1&gt;</p><script>evil()</script><ul><li>a</li><li>b</li></ul></body></html>');
    assert.equal(title, 'T & T');
    assert.match(text, /# Head/);
    assert.match(text, /Para <1>/);
    assert.ok(!/evil|menu/.test(text));
  });
});

describe('fetch_url safety', () => {
  test('private address detection', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.4', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  });
  test('refuses localhost unless allowed', async () => {
    await assert.rejects(fetchUrl('http://127.0.0.1:1/x'), /private network|local address/);
    await assert.rejects(fetchUrl('http://localhost:1/x'), /local address/);
    await assert.rejects(fetchUrl('file:///etc/passwd'), /Only http/);
  });
});

describe('settings validation', () => {
  test('accepts valid patches and rejects bad ones with a path', () => {
    assert.equal(validatePatch(SETTINGS_SCHEMA, { context: { mode: 'max' }, params: { temperature: 0.7 }, image: { unloadChatModel: 'always' } }), null);
    assert.match(validatePatch(SETTINGS_SCHEMA, { context: { mode: 'huge' } }), /context\.mode/);
    assert.match(validatePatch(SETTINGS_SCHEMA, { params: { temperature: 9 } }), /params\.temperature/);
    assert.match(validatePatch(SETTINGS_SCHEMA, { nope: 1 }), /Unknown setting nope/);
    assert.equal(validatePatch(SETTINGS_SCHEMA, { ui: { theme: 'dark', anything: { nested: true } } }), null);
  });
});

describe('ComfyUI workflow placeholders', () => {
  test('numeric placeholders become numbers, strings are substituted', () => {
    const wf = fillWorkflow(DEFAULT_TXT2IMG_WORKFLOW, { prompt: 'a cat', negative_prompt: 'blurry', seed: 42, steps: 4, cfg: 1.5, width: 512, height: 768, count: 1, model: 'm.safetensors', sampler: 'euler', scheduler: 'normal' });
    assert.equal(wf[3].inputs.seed, 42);
    assert.equal(wf[5].inputs.height, 768);
    assert.equal(wf[6].inputs.text, 'a cat');
    assert.equal(wf[4].inputs.ckpt_name, 'm.safetensors');
    const custom = fillWorkflow({ 1: { inputs: { text: 'style: {{prompt}}, seed {{seed}}', keep: '{{unknown}}' } } }, { prompt: 'x', seed: 7 });
    assert.equal(custom[1].inputs.text, 'style: x, seed 7');
    assert.equal(custom[1].inputs.keep, '{{unknown}}');
  });
});
