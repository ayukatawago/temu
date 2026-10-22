// Android-Studio-lite log filter: `tag:X package:X process:X message:X level:W -tag:X word -word`.
// Positive terms with the same key are OR'd, different keys are AND'd, and every negation is
// AND'd, as in Android Studio. An unparseable term degrades to a bare word instead of throwing,
// so a half-typed query never breaks the view.

import { formatEntry, levelRank, type LogContext, type LogEntry, type LogLevel } from './entry.js';

export type LogPredicate = (entry: LogEntry, ctx: LogContext) => boolean;

type TermKey = 'tag' | 'process' | 'message' | 'line';

interface Term {
  key: TermKey;
  value: string;
  negated: boolean;
}

const LEVEL_WORDS: Record<string, LogLevel> = {
  v: 'V',
  verbose: 'V',
  d: 'D',
  debug: 'D',
  i: 'I',
  info: 'I',
  w: 'W',
  warn: 'W',
  warning: 'W',
  e: 'E',
  error: 'E',
  a: 'A',
  assert: 'A',
  fatal: 'A',
};

const KEY_ALIASES: Record<string, TermKey | 'level'> = {
  tag: 'tag',
  package: 'process',
  process: 'process',
  message: 'message',
  level: 'level',
};

/** Splits on whitespace, keeping `"quoted values"` (and `key:"quoted value"`) together. */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function parseFilter(query: string): LogPredicate {
  const terms: Term[] = [];
  let minLevel: LogLevel | null = null;

  for (const token of tokenize(query)) {
    const negated = token.startsWith('-') && token.length > 1;
    const body = negated ? token.slice(1) : token;
    const colon = body.indexOf(':');
    const key = colon > 0 ? KEY_ALIASES[body.slice(0, colon).toLowerCase()] : undefined;
    const value = colon > 0 ? body.slice(colon + 1) : body;

    if (key === 'level') {
      const level = LEVEL_WORDS[value.toLowerCase()];
      if (level && !negated) {
        minLevel = level;
        continue;
      }
      terms.push({ key: 'line', value: body.toLowerCase(), negated });
      continue;
    }
    if (key) {
      if (value.length > 0) {
        terms.push({ key, value: value.toLowerCase(), negated });
      }
      continue;
    }
    terms.push({ key: 'line', value: body.toLowerCase(), negated });
  }

  const positive = new Map<TermKey, string[]>();
  const negatives: Term[] = [];
  for (const term of terms) {
    if (term.negated) {
      negatives.push(term);
    } else {
      positive.set(term.key, [...(positive.get(term.key) ?? []), term.value]);
    }
  }

  return (entry, ctx) => {
    if (minLevel && levelRank(entry.level) < levelRank(minLevel)) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    // Computed lazily and at most once per call — formatting every entry up front would be wasted
    // work for the common case of a filter with no bare words.
    let line: string | undefined;
    const fieldOf = (key: TermKey): string => {
      switch (key) {
        case 'tag':
          return entry.tag.toLowerCase();
        case 'process':
          return (ctx.processName(entry) ?? '').toLowerCase();
        case 'message':
          return entry.message.toLowerCase();
        case 'line':
          line ??= formatEntry(entry, ctx).toLowerCase();
          return line;
      }
    };
    for (const [key, values] of positive) {
      const field = fieldOf(key);
      if (!values.some((value) => field.includes(value))) {
        return false;
      }
    }
    return negatives.every((term) => !fieldOf(term.key).includes(term.value));
  };
}
