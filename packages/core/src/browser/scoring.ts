export interface ScorableElement {
  role: string;
  name: string;
  context: string;
}

const NAME_WEIGHT = 3;
const CONTEXT_WEIGHT = 1;
const ROLE_BONUS = 0.25;
const SUBSTRING_BONUS = 0.5;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function withinEditDistanceOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (shorter.length === longer.length) i++;
    j++;
  }
  return edits + (longer.length - j) <= 1;
}

function tokenMatch(queryToken: string, fieldToken: string): number {
  if (queryToken === fieldToken) return 1;
  if (
    queryToken.length >= 3 &&
    fieldToken.length >= 3 &&
    (fieldToken.startsWith(queryToken) || queryToken.startsWith(fieldToken))
  ) {
    return 0.6;
  }
  if (queryToken.length >= 4 && fieldToken.length >= 4 && withinEditDistanceOne(queryToken, fieldToken)) {
    return 0.5;
  }
  return 0;
}

function fieldScore(queryTokens: string[], field: string): number {
  if (queryTokens.length === 0) return 0;
  const fieldTokens = tokenize(field);
  if (fieldTokens.length === 0) return 0;
  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const f of fieldTokens) {
      best = Math.max(best, tokenMatch(q, f));
      if (best === 1) break;
    }
    total += best;
  }
  let score = total / queryTokens.length;
  const queryJoined = queryTokens.join(' ');
  const fieldJoined = fieldTokens.join(' ');
  if (queryJoined && fieldJoined && (fieldJoined.includes(queryJoined) || queryJoined.includes(fieldJoined))) {
    score += SUBSTRING_BONUS;
  }
  return score;
}

export function scoreElement(query: string, element: ScorableElement): number {
  const queryTokens = tokenize(query);
  const nameScore = fieldScore(queryTokens, element.name);
  const contextScore = fieldScore(queryTokens, element.context);
  const roleBonus = queryTokens.includes(element.role.toLowerCase()) ? ROLE_BONUS : 0;
  return nameScore * NAME_WEIGHT + contextScore * CONTEXT_WEIGHT + roleBonus;
}

export function rankElements<T extends ScorableElement>(query: string, elements: T[], topK = 5): T[] {
  return elements
    .map((element, index) => ({ element, index, score: scoreElement(query, element) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topK)
    .map((entry) => entry.element);
}
