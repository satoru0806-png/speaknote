const STORAGE_KEY = "speaknote-user-dict";

export type DictEntry = {
  wrong: string;
  correct: string;
};

export function loadDict(): DictEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDict(dict: DictEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dict));
}

export function addToDict(wrong: string, correct: string): DictEntry[] {
  const dict = loadDict();
  // Update if same "wrong" exists, otherwise add
  const idx = dict.findIndex((d) => d.wrong === wrong);
  if (idx >= 0) {
    dict[idx].correct = correct;
  } else {
    dict.push({ wrong, correct });
  }
  saveDict(dict);
  return dict;
}

export function removeFromDict(wrong: string): DictEntry[] {
  const dict = loadDict().filter((d) => d.wrong !== wrong);
  saveDict(dict);
  return dict;
}

export function applyDict(text: string): string {
  const dict = loadDict();
  let result = text;
  // Sort by length descending so longer matches take priority
  const sorted = [...dict].sort((a, b) => b.wrong.length - a.wrong.length);
  for (const { wrong, correct } of sorted) {
    result = result.split(wrong).join(correct);
  }
  return result;
}
