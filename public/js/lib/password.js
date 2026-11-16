// Honest password feedback without composition rules. It estimates how many guesses an attacker who has a
// copy of the encrypted data would need, from the patterns people actually use (common passwords, words,
// years, keyboard runs, repeats), and turns that into a plain sentence. Harness only requires 8 characters.
//
// Each guess costs the attacker one scrypt run (N = 2^17, 128 MiB). Assume a well-equipped attacker manages
// about 10,000 guesses per second across many machines; that is generous to the attacker, on purpose.

const GUESSES_PER_SECOND = 1e4;
const MIN_LENGTH = 8;

// The most common passwords and bases (lower-case, leetspeak undone). Short on purpose: anything on a list
// like this is guessed in the first second of an attack.
const COMMON = new Set(`password passw0rd passwort motdepasse contraseña 123456 1234567 12345678 123456789 1234567890 12345
qwerty qwertyuiop qwertz azerty asdfgh asdfghjkl zxcvbn zxcvbnm 1q2w3e4r 1qaz2wsx qazwsx abc123 abcdef abcdefg abcdefgh
iloveyou letmein welcome admin administrator login master secret sunshine princess dragon monkey football baseball
soccer hockey shadow superman batman trustno1 starwars whatever freedom computer internet harness ollama michael
jennifer jordan hunter ranger buster thomas robert daniel charlie andrew jessica ashley loveme lovely hello hello123
welcome1 password1 password123 qwerty123 iloveyou1 changeme default access flower summer winter autumn spring
monday friday google apple samsung macbook iphone mypassword mysecret opensesame 000000 111111 121212 123123 654321
666666 696969 777777 888888 987654321 99999999 11111111 00000000 87654321 55555555 aaaaaa`.split(/\s+/).filter(Boolean));

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qwertzuiop', 'azertyuiop', 'yxcvbnm'];

const unleet = (s) => s.toLowerCase().replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i').replace(/0/g, 'o').replace(/[$5]/g, 's').replace(/7/g, 't');

function isSequence(s) {
  if (s.length < 3) return false;
  const c = [...s.toLowerCase()].map((x) => x.codePointAt(0));
  const d = c[1] - c[0];
  if (Math.abs(d) !== 1) return false;
  return c.every((v, i) => i === 0 || v - c[i - 1] === d);
}

function isKeyboardRun(s) {
  const l = s.toLowerCase();
  if (l.length < 4) return false;
  return KEYBOARD_ROWS.some((row) => row.includes(l) || [...row].reverse().join('').includes(l));
}

function isRepeat(s) {
  if (s.length < 3) return false;
  for (let n = 1; n <= s.length / 2; n++) {
    if (s.length % n) continue;
    if (s.slice(0, n).repeat(s.length / n) === s) return true;
  }
  return false;
}

const VOWELS = /[aeiouyäöüéèàáíóú]/i;
function looksLikeWords(run) {
  const l = run.toLowerCase();
  const vowels = [...l].filter((ch) => VOWELS.test(ch)).length;
  const ratio = vowels / l.length;
  return ratio >= 0.2 && ratio <= 0.7 && !/[^aeiouy\s]{5,}/i.test(l);
}

/** A dictionary word: short words are the most common ones (about 2^10 of them), long ones rarer. */
function wordBits(w) {
  const lower = w.toLowerCase();
  const caps = w === lower ? 0 : (w[0] !== lower[0] && w.slice(1) === lower.slice(1) ? 1 : 2.5);
  if (!looksLikeWords(w)) return w.length * (caps ? 5.7 : 4.7);
  return (w.length <= 3 ? 10 : w.length <= 5 ? 13 : 15) + caps;
}

/** log2 of the estimated number of guesses for one run of letters, digits or symbols. */
function runBits(run) {
  if (isRepeat(run)) return Math.log2(run.length * 40);
  if (isSequence(run) || isKeyboardRun(run)) return Math.log2(run.length * 60);
  if (/^\d+$/.test(run)) {
    if (/^(19|20)\d\d$/.test(run)) return 7; // a year
    if (run.length === 6 || run.length === 8) {
      // dates like 010190 / 01011990
      if (/^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])/.test(run) || /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.test(run)) return Math.min(run.length * 3.32, 15);
    }
    return run.length * 3.32;
  }
  if (/^\p{L}+$/u.test(run)) {
    const lower = run.toLowerCase();
    if (COMMON.has(unleet(run))) return 4 + (run !== lower ? 1 : 0);
    // Keyboard mashing on one row ("asdfjkl…") is far less random than it looks.
    if (KEYBOARD_ROWS.some((row) => [...lower].every((ch) => row.includes(ch)))) return run.length * 2.2;
    const caps = run !== lower ? 1 : 0;
    const random = run.length * (caps ? 5.7 : 4.7);
    // CamelCase joins words: "ZebraLampOcean" is three words.
    const parts = run.split(/(?<=\p{Ll})(?=\p{Lu})/u);
    if (parts.length > 1) return Math.min(random, parts.reduce((b, w) => b + wordBits(w), 0));
    if (looksLikeWords(run)) {
      // Dictionary words: a long run may be several words joined together.
      const words = Math.max(1, Math.round(run.length / 6.5));
      return Math.min(random, words === 1 ? wordBits(run) : words * 15 + caps);
    }
    return random;
  }
  // symbols / other scripts
  return run.length * 5;
}

/** Split into runs of letters / digits / symbols / spaces (spaces separate words for free) and add them up. */
function patternBits(pw) {
  const runs = pw.match(/\p{L}+|\d+|\s+|[^\p{L}\d\s]+/gu) || [];
  let bits = 0;
  for (const r of runs) bits += /^\s+$/.test(r) ? 0.5 : runBits(r);
  return bits + Math.log2(Math.max(1, runs.length)); // a little for how the pieces are arranged
}

/** Undo leetspeak inside chunks that mix letters with look-alike digits/symbols ("Tr0ub4dor" → "Troubador"). */
function unleetMixed(pw) {
  return pw.replace(/[\p{L}\d@$!|]+/gu, (chunk) => {
    if (!/\p{L}/u.test(chunk) || !/[\d@$!|]/.test(chunk)) return chunk;
    const m = { '@': 'a', 4: 'a', 3: 'e', 1: 'i', '!': 'i', '|': 'i', 0: 'o', $: 's', 5: 's', 7: 't' };
    // Only digits/symbols between or right after letters are substitutions; a trailing number stays a number.
    return chunk.replace(/(?<=\p{L})[@4310!|$57]+(?=\p{L})|^[@$](?=\p{L})/gu, (x) => [...x].map((c) => m[c] || c).join(''));
  });
}

/**
 * Estimate the strength of a password.
 * → { ok, score 0–4, label, detail, bits, seconds }
 *   ok: Harness accepts it (8+ characters)
 */
export function passwordStrength(pw) {
  const chars = [...(pw || '')];
  if (!chars.length) return { ok: false, score: 0, label: '', detail: `Use at least ${MIN_LENGTH} characters. Several random words are strong and easy to remember.`, bits: 0, seconds: 0 };
  if (chars.length < MIN_LENGTH) return { ok: false, score: 0, label: 'Too short', detail: `Harness needs at least ${MIN_LENGTH} characters (${MIN_LENGTH - chars.length} more).`, bits: 0, seconds: 0 };
  const whole = unleet(pw.replace(/[\s\d!?.]+$/, ''));
  if (COMMON.has(unleet(pw)) || COMMON.has(whole) || isRepeat(pw) || isSequence(pw) || isKeyboardRun(pw)) {
    return { ok: true, score: 0, label: 'Very easy to guess', detail: 'This is one of the first things anyone trying to guess passwords would try.', bits: 10, seconds: 0 };
  }
  const bits = Math.min(patternBits(pw), patternBits(unleetMixed(pw)) + 1);
  const seconds = 2 ** Math.max(0, bits - 1) / GUESSES_PER_SECOND;
  let score;
  let label;
  if (seconds < 3600 * 24) { score = 1; label = 'Easy to guess'; } else if (seconds < 3600 * 24 * 365) { score = 2; label = 'Fair'; } else if (seconds < 3600 * 24 * 365 * 1000) { score = 3; label = 'Good'; } else { score = 4; label = 'Strong'; }
  const when = describeDuration(seconds);
  const detail = score >= 4
    ? 'Someone with a copy of your data could not realistically guess this.'
    : `Someone with a copy of your data could guess this in ${when}.${score <= 2 ? ' Adding another word or two makes a big difference.' : ''}`;
  return { ok: true, score, label, detail, bits: Math.round(bits), seconds };
}

function describeDuration(s) {
  if (s < 60) return 'under a minute';
  if (s < 3600) return `about ${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;
  if (s < 86400) return `about ${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? '' : 's'}`;
  if (s < 86400 * 60) return `about ${Math.round(s / 86400)} days`;
  if (s < 86400 * 365 * 2) return `about ${Math.round(s / (86400 * 30))} months`;
  const y = s / (86400 * 365);
  if (y < 1000) return `about ${Math.round(y)} years`;
  return 'thousands of years';
}

// ------------------------------------------------------------------------------------------------ recovery key
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Normalise what the user typed: case, spaces and dashes ignored, I/L → 1, O → 0, HRK1 prefix optional. */
export function normalizeRecoveryKey(text) {
  let s = String(text || '').toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.startsWith('HRK1')) s = s.slice(4);
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
  return s;
}

/** True when it has the right length and only valid characters (the server still decides). */
export function looksLikeRecoveryKey(text) {
  const s = normalizeRecoveryKey(text);
  return s.length === 52 && [...s].every((c) => CROCKFORD.includes(c));
}

/** HRK1-XXXX-… for display, from whatever the user typed. */
export function formatRecoveryKey(text) {
  const s = normalizeRecoveryKey(text);
  return `HRK1-${s.match(/.{1,4}/g)?.join('-') || ''}`;
}

/** Split a recovery key into its groups (for a readable display). */
export function recoveryKeyGroups(key) {
  return String(key || '').split('-').filter(Boolean);
}
