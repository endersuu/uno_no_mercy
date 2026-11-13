export interface HandLayout {
  pageSize: number;
  cardWidth: number;
  paginated: boolean;
}

/** Size complete card faces inside the space left after the fixed game controls. */
export function layoutHand(hand: HTMLElement, count: number): HandLayout {
  const style = getComputedStyle(hand);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const rect = hand.getBoundingClientRect();
  const width = Math.max(
    1,
    Math.floor(
      Math.min(
        rect.width - px(style.borderLeftWidth) - px(style.borderRightWidth),
        hand.clientWidth,
      ) -
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
  const portraitPhone = matchMedia(
    "(max-width: 650px) and (orientation: portrait)",
  ).matches;
  // A phone's entire hand remains available at once. Use small, complete faces;
  // only the hand scrolls if even 44px touch targets cannot fit the visible height.
  const minWidth = portraitPhone ? 44 : 56;
  const maxWidth = Math.max(
    minWidth,
    Math.min(
      portraitPhone ? 70 : 92,
      Math.floor(width),
      Math.floor(height / 1.5),
    ),
  );
  const minimumPages = portraitPhone
    ? 1
    : Math.max(1, Math.ceil(count / capacity(minWidth)));
  let cardWidth = minWidth;
  for (let candidate = maxWidth; candidate >= minWidth; candidate--) {
    if (Math.ceil(count / capacity(candidate)) <= minimumPages) {
      cardWidth = candidate;
      break;
    }
  }
  hand.style.setProperty("--hand-card-width", `${cardWidth}px`);
  return {
    pageSize: portraitPhone ? Math.max(1, count) : capacity(cardWidth),
    cardWidth,
    paginated: !portraitPhone,
  };
}
