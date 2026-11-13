export interface HandLayout {
  pageSize: number;
  cardWidth: number;
}

/** Size complete card faces inside the space left after the fixed game controls. */
export function layoutHand(hand: HTMLElement, count: number): HandLayout {
  const style = getComputedStyle(hand);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const rect = hand.getBoundingClientRect();
  const width = Math.max(
    1,
    Math.floor(
      rect.width -
        px(style.borderLeftWidth) -
        px(style.borderRightWidth) -
        px(style.paddingLeft) -
        px(style.paddingRight),
    ),
  );
  const height = Math.max(
    1,
    Math.floor(
      rect.height -
        px(style.borderTopWidth) -
        px(style.borderBottomWidth) -
        px(style.paddingTop) -
        px(style.paddingBottom),
    ),
  );
  const columnGap = px(style.columnGap),
    rowGap = px(style.rowGap);
  const capacity = (cardWidth: number) =>
    Math.max(1, Math.floor((width + columnGap) / (cardWidth + columnGap))) *
    Math.max(1, Math.floor((height + rowGap) / (cardWidth * 1.5 + rowGap)));
  // Keep touch targets readable. Additional cards get a page, never a clipped face.
  const minWidth = 56;
  const maxWidth = Math.max(
    minWidth,
    Math.min(92, Math.floor(width), Math.floor(height / 1.5)),
  );
  const minimumPages = Math.max(1, Math.ceil(count / capacity(minWidth)));
  let cardWidth = minWidth;
  for (let candidate = maxWidth; candidate >= minWidth; candidate--) {
    if (Math.ceil(count / capacity(candidate)) <= minimumPages) {
      cardWidth = candidate;
      break;
    }
  }
  hand.style.setProperty("--hand-card-width", `${cardWidth}px`);
  return { pageSize: capacity(cardWidth), cardWidth };
}
