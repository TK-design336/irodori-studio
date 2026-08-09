import { EMOJI_PALETTE_ITEMS } from "../lib/emojiPalette";

type Props = {
  open: boolean;
  onInsert: (emoji: string) => void;
};

export function EmojiPalette({ open, onInsert }: Props) {
  if (!open) return null;
  return (
    <div className="emoji-palette" data-irodori-emoji-palette="true">
      <div className="emoji-palette-grid">
        {EMOJI_PALETTE_ITEMS.map((item) => {
          const title = `${item.label}: ${item.description}`;
          return (
            <button
              key={item.emoji + item.label}
              type="button"
              className="emoji-palette-button"
              title={title}
              aria-label={title}
              onPointerDown={(e) => {
                // フォーカスを奪わず、選択中ラインのキャレット位置へ挿入
                e.preventDefault();
                onInsert(item.emoji);
              }}
            >
              {item.emoji}
            </button>
          );
        })}
      </div>
    </div>
  );
}
