import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_KIND_FILTER,
  DEFAULT_SPEAKER_SORT,
  type KindFilterKey,
  type SortDir,
  type SortKey,
  type SpeakerSortState,
} from "../lib/speakerSort";

const STORAGE_KEY = "irodori.speakerSort";

type SpeakerSortContextValue = SpeakerSortState & {
  setSortKey: (key: SortKey) => void;
  setSortDir: (dir: SortDir) => void;
  clickSort: (key: SortKey) => void;
  toggleKindFilter: (key: KindFilterKey) => void;
  /** Toggle one tag. From the "all selected" state, clicking a tag isolates that tag. */
  toggleTagFilter: (tag: string, allTags: string[]) => void;
  selectAllTags: () => void;
  resetSort: () => void;
  isTagSelected: (tag: string, allTags: string[]) => boolean;
  areAllTagsSelected: (allTags: string[]) => boolean;
  sortDirMark: (key: SortKey) => string;
};

const SpeakerSortContext = createContext<SpeakerSortContextValue | null>(null);

function isSortKey(v: unknown): v is SortKey {
  return (
    v === "name" || v === "realName" || v === "gender" || v === "age"
  );
}

function isSortDir(v: unknown): v is SortDir {
  return v === "asc" || v === "desc";
}

function defaultSortState(): SpeakerSortState {
  return {
    ...DEFAULT_SPEAKER_SORT,
    kindFilter: { ...DEFAULT_KIND_FILTER },
    tagFilter: null,
  };
}

function loadStored(): SpeakerSortState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultSortState();
    }
    const parsed = JSON.parse(raw) as Partial<SpeakerSortState> & {
      sortKey?: string;
    };
    const kindFilter = { ...DEFAULT_KIND_FILTER };
    if (parsed.kindFilter && typeof parsed.kindFilter === "object") {
      for (const k of Object.keys(DEFAULT_KIND_FILTER) as KindFilterKey[]) {
        if (typeof parsed.kindFilter[k] === "boolean") {
          kindFilter[k] = parsed.kindFilter[k];
        }
      }
    }
    let tagFilter: string[] | null = null;
    if (Array.isArray(parsed.tagFilter)) {
      tagFilter = parsed.tagFilter.filter((t): t is string => typeof t === "string");
    }
    // Migrate away from removed "tag" sort key
    const sortKey = isSortKey(parsed.sortKey)
      ? parsed.sortKey
      : "name";
    return {
      sortKey,
      sortDir: isSortDir(parsed.sortDir) ? parsed.sortDir : "asc",
      kindFilter,
      tagFilter,
    };
  } catch {
    return defaultSortState();
  }
}

export function SpeakerSortProvider({
  children,
  persist = true,
}: {
  children: ReactNode;
  persist?: boolean;
}) {
  const [state, setState] = useState<SpeakerSortState>(() =>
    persist ? loadStored() : defaultSortState(),
  );

  useEffect(() => {
    if (!persist) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* */
    }
  }, [state, persist]);

  const setSortKey = useCallback((key: SortKey) => {
    setState((prev) => ({ ...prev, sortKey: key }));
  }, []);

  const setSortDir = useCallback((dir: SortDir) => {
    setState((prev) => ({ ...prev, sortDir: dir }));
  }, []);

  const clickSort = useCallback((key: SortKey) => {
    setState((prev) => {
      if (prev.sortKey === key) {
        return {
          ...prev,
          sortDir: prev.sortDir === "asc" ? "desc" : "asc",
        };
      }
      return { ...prev, sortKey: key, sortDir: "asc" };
    });
  }, []);

  const toggleKindFilter = useCallback((key: KindFilterKey) => {
    setState((prev) => ({
      ...prev,
      kindFilter: { ...prev.kindFilter, [key]: !prev.kindFilter[key] },
    }));
  }, []);

  const selectAllTags = useCallback(() => {
    setState((prev) => ({ ...prev, tagFilter: null }));
  }, []);

  const resetSort = useCallback(() => {
    setState(defaultSortState());
  }, []);

  const toggleTagFilter = useCallback((tag: string, allTags: string[]) => {
    setState((prev) => {
      const allSelected =
        prev.tagFilter === null ||
        (allTags.length > 0 &&
          prev.tagFilter.length === allTags.length &&
          allTags.every((t) => prev.tagFilter!.includes(t)));
      // From "all selected", clicking a tag shows only that tag.
      if (allSelected && allTags.length > 1) {
        return { ...prev, tagFilter: [tag] };
      }
      const current =
        prev.tagFilter === null ? [...allTags] : [...prev.tagFilter];
      const idx = current.indexOf(tag);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(tag);
      if (
        allTags.length > 0 &&
        allTags.every((t) => current.includes(t)) &&
        current.length === allTags.length
      ) {
        return { ...prev, tagFilter: null };
      }
      return { ...prev, tagFilter: current };
    });
  }, []);

  const isTagSelected = useCallback(
    (tag: string, allTags: string[]) => {
      if (state.tagFilter === null) return allTags.includes(tag) || allTags.length === 0;
      return state.tagFilter.includes(tag);
    },
    [state.tagFilter],
  );

  const areAllTagsSelected = useCallback(
    (allTags: string[]) => {
      if (state.tagFilter === null) return true;
      if (allTags.length === 0) return true;
      return (
        allTags.every((t) => state.tagFilter!.includes(t)) &&
        state.tagFilter.length === allTags.length
      );
    },
    [state.tagFilter],
  );

  const sortDirMark = useCallback(
    (key: SortKey) =>
      state.sortKey === key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "",
    [state.sortKey, state.sortDir],
  );

  const value = useMemo<SpeakerSortContextValue>(
    () => ({
      ...state,
      setSortKey,
      setSortDir,
      clickSort,
      toggleKindFilter,
      toggleTagFilter,
      selectAllTags,
      resetSort,
      isTagSelected,
      areAllTagsSelected,
      sortDirMark,
    }),
    [
      state,
      setSortKey,
      setSortDir,
      clickSort,
      toggleKindFilter,
      toggleTagFilter,
      selectAllTags,
      resetSort,
      isTagSelected,
      areAllTagsSelected,
      sortDirMark,
    ],
  );

  return (
    <SpeakerSortContext.Provider value={value}>
      {children}
    </SpeakerSortContext.Provider>
  );
}

export function useSpeakerSort(): SpeakerSortContextValue {
  const ctx = useContext(SpeakerSortContext);
  if (!ctx) {
    throw new Error("useSpeakerSort must be used within SpeakerSortProvider");
  }
  return ctx;
}
