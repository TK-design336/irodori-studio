import type { ReplaceEntry } from "./replaceApply";

export type HomographEntry = {
  id: string;
  surface: string;
  note?: string;
  enabled: boolean;
};

export type Dictionaries = {
  replace: ReplaceEntry[];
  homograph: HomographEntry[];
};

export const emptyDictionaries = (): Dictionaries => ({
  replace: [],
  homograph: [],
});

export function newDictId(): string {
  return crypto.randomUUID();
}
