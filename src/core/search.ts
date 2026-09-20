export interface SearchNote {
  path: string;
  title: string;
  text: string;
  tags: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  heading: string;
  text: string;
  startLine: number;
  score: number;
  id: string;
}

/** Prefix for a whole-word token, so it can never collide with a bigram of the same characters. */
export const WORD_PREFIX = 'w:';
/** Prefix for a single-kanji fallback token, distinct from single ASCII or Hiragana characters. */
export const CHAR_PREFIX = 'c:';

/**
 * Weighted Hybrid Tokenizer:
 * - NFKC ASCII words
 * - Japanese run bigrams (overlapping 2-grams)
 * - Katakana whole words (e.g. w:デプロイ) with 1.2x scoring weight
 * - Han whole compound words (e.g. w:障害, w:経費精算) with 1.2x scoring weight
 * - Han unigrams as fallback anchors (e.g. c:障, c:害) with 0.5x scoring weight
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const runs = text.normalize('NFKC').toLowerCase().match(
    /[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu,
  ) ?? [];
  for (const run of runs) {
    if (/^[a-z0-9_]/.test(run)) {
      tokens.push(run);
    } else {
      const points = Array.from(run);
      if (points.length === 1) {
        tokens.push(run);
      } else {
        for (let i = 1; i < points.length; i++) tokens.push(points[i - 1] + points[i]);
      }
      // Katakana whole words (length >= 2)
      for (const span of run.match(/[\p{Script=Katakana}ー]{2,}/gu) ?? []) tokens.push(WORD_PREFIX + span);
      // Han whole words (compounds of 2 to 8 characters)
      for (const span of run.match(/[\p{Script=Han}]{2,8}/gu) ?? []) tokens.push(WORD_PREFIX + span);
      // Han unigrams as fallback anchors
      for (const ch of points) {
        if (/^[\p{Script=Han}]$/u.test(ch)) tokens.push(CHAR_PREFIX + ch);
      }
    }
  }
  return tokens;
}

function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part.toLowerCase());
  }
  return parts.join('/');
}

function within(value: string, parent: string): boolean {
  return value === parent || value.startsWith(parent + '/');
}

/** Conservative, case-insensitive exclusions; folder/tag prefixes require a slash boundary. */
export function isExcluded(
  path: string,
  tags: string[],
  folders: string[],
  excludedTags: string[],
  configDir: string,
): boolean {
  const normalized = normalizePath(path);
  if (normalized === null) return true;
  if (normalized.split('/').slice(0, -1).some(part => part.startsWith('.'))) return true;
  for (const folder of [configDir, ...folders]) {
    if (!folder.trim()) continue;
    const parent = normalizePath(folder.trim());
    if (parent !== null && (parent === '' || within(normalized, parent))) return true;
  }
  const normalizeTag = (tag: string): string => tag.trim().replace(/^#+/, '').replace(/\/+$/, '').toLowerCase();
  return excludedTags.some(excluded => {
    const parent = normalizeTag(excluded);
    return parent !== '' && tags.some(tag => within(normalizeTag(tag), parent));
  });
}

interface Fragment {
  heading: string;
  text: string;
  startLine: number;
}

const MAX_POINTS = 1200;
const OVERLAP = 120;
const MAX_BYTES = 1024 * 1024;

function splitSection(text: string, heading: string, startLine: number): Fragment[] {
  const points = Array.from(text);
  const lines: number[] = [];
  let line = startLine;
  for (let i = 0; i < points.length; i++) {
    lines.push(line);
    if (points[i] === '\n' || (points[i] === '\r' && points[i + 1] !== '\n')) line++;
  }
  const result: Fragment[] = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(start + MAX_POINTS, points.length);
    let hardSplit = end < points.length;
    if (hardSplit) {
      const window = points.slice(start, end).join('');
      let boundary = 0;
      for (const match of window.matchAll(/(?:\r?\n|\r(?!\n))[ \t]*(?:\r?\n|\r(?!\n))/g)) {
        boundary = match.index! + match[0].length;
      }
      if (boundary > 0) {
        end = start + Array.from(window.slice(0, boundary)).length;
        hardSplit = false;
      }
    }
    const body = points.slice(start, end).join('');
    if (body.trim()) result.push({ heading, text: body, startLine: lines[start] });
    if (end === points.length) break;
    start = hardSplit ? end - OVERLAP : end;
  }
  return result;
}

/** Small ATX/fence scanner, not a general Markdown or YAML parser. */
function fragments(text: string): Fragment[] {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  let first = 0;
  if (/^\uFEFF?---[ \t]*(?:\r\n|\r|\n)?$/.test(lines[0] ?? '')) {
    first = 1;
    while (first < lines.length && !/^(?:---|\.\.\.)[ \t]*(?:\r\n|\r|\n)?$/.test(lines[first])) first++;
    // An unclosed opening frontmatter block is withheld rather than leaked.
    if (first === lines.length) return [];
    first++;
  }
  const result: Fragment[] = [];
  let heading = '';
  let sectionStart = first;
  let fence = '';
  let fenceLength = 0;
  const flush = (end: number): void => {
    result.push(...splitSection(lines.slice(sectionStart, end).join(''), heading, sectionStart + 1));
  };
  for (let i = first; i < lines.length; i++) {
    const line = lines[i].replace(/(?:\r\n|\r|\n)$/, '');
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence && close[1].length >= fenceLength) fence = '';
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = open[1][0];
      fenceLength = open[1].length;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (atx) {
      flush(i);
      heading = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      sectionStart = i;
    }
  }
  flush(lines.length);
  return result;
}

function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface Field {
  terms: Map<string, number>;
  length: number;
}
interface Entry {
  hit: SearchHit;
  fields: Field[];
}

export type Tokenizer = (text: string) => string[];

function field(text: string, tokenizer: Tokenizer): Field {
  const tokens = tokenizer(text);
  const terms = new Map<string, number>();
  for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
  return { terms, length: tokens.length };
}

/** In-memory fielded BM25 over chunks. Exclusion policy is applied by the caller. */
export class SearchIndex {
  /** The tokenizer is injectable so alternative segmentations can be measured against the same corpus. */
  private readonly tokenizer: Tokenizer;

  constructor(tokenizer: Tokenizer = tokenize) {
    this.tokenizer = tokenizer;
  }

  private readonly notes = new Map<string, string[]>();
  private readonly entries = new Map<string, Entry>();
  private readonly postings: Map<string, Map<string, number>>[] = [new Map(), new Map(), new Map()];
  private readonly totalLengths = [0, 0, 0];

  /** Number of notes with at least one retained chunk, not the number of chunks. */
  get size(): number {
    return this.notes.size;
  }

  upsert(note: SearchNote): void {
    this.remove(note.path);
    // Check UTF-8 bytes, not UTF-16 units; avoid allocating bytes for obviously oversized input.
    if (note.text.length > MAX_BYTES || new TextEncoder().encode(note.text).length > MAX_BYTES) return;
    const chunks = fragments(note.text);
    if (!chunks.length) return;
    const ids: string[] = [];
    const title = field(note.title, this.tokenizer);
    chunks.forEach((chunk, ordinal) => {
      const id = JSON.stringify([note.path, chunk.startLine, ordinal, contentHash(chunk.text)]);
      const hit: SearchHit = { ...chunk, path: note.path, title: note.title, id, score: 0 };
      const fields = [title, field(chunk.heading, this.tokenizer), field(chunk.text, this.tokenizer)];
      this.entries.set(id, { hit, fields });
      ids.push(id);
      fields.forEach((value, index) => {
        this.totalLengths[index] += value.length;
        for (const [term, tf] of value.terms) {
          let posting = this.postings[index].get(term);
          if (!posting) this.postings[index].set(term, posting = new Map());
          posting.set(id, tf);
        }
      });
    });
    this.notes.set(note.path, ids);
  }

  remove(path: string): void {
    for (const id of this.notes.get(path) ?? []) {
      const entry = this.entries.get(id)!;
      entry.fields.forEach((value, index) => {
        this.totalLengths[index] -= value.length;
        for (const term of value.terms.keys()) {
          const posting = this.postings[index].get(term)!;
          posting.delete(id);
          if (!posting.size) this.postings[index].delete(term);
        }
      });
      this.entries.delete(id);
    }
    this.notes.delete(path);
  }

  clear(): void {
    this.notes.clear();
    this.entries.clear();
    this.postings.forEach(posting => posting.clear());
    this.totalLengths.fill(0);
  }

  /** OR-match query terms. No per-note cap or external reranking is applied here. */
  search(query: string, limit = 50): SearchHit[] {
    if (Number.isNaN(limit) || limit <= 0 || !this.entries.size) return [];
    const terms = new Set(this.tokenizer(query));
    if (!terms.size) return [];
    const scores = new Map<string, number>();
    const count = this.entries.size;
    const weights = [3, 1.5, 1];
    this.postings.forEach((index, fieldIndex) => {
      const averageLength = this.totalLengths[fieldIndex] / count;
      for (const term of terms) {
        const posting = index.get(term);
        if (!posting) continue;
        const idf = Math.log(1 + (count - posting.size + 0.5) / (posting.size + 0.5));
        let tokenWeight = 1;
        if (term.startsWith(WORD_PREFIX)) tokenWeight = 1.2;
        else if (term.startsWith(CHAR_PREFIX)) tokenWeight = 0.5;
        for (const [id, tf] of posting) {
          const length = this.entries.get(id)!.fields[fieldIndex].length;
          const bm25 = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / averageLength));
          scores.set(id, (scores.get(id) ?? 0) + weights[fieldIndex] * bm25 * tokenWeight);
        }
      }
    });
    const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
    return Array.from(scores, ([id, score]) => ({ ...this.entries.get(id)!.hit, score }))
      .sort((a, b) => b.score - a.score || compare(a.path, b.path) || a.startLine - b.startLine || compare(a.id, b.id))
      .slice(0, Math.floor(limit));
  }
}
