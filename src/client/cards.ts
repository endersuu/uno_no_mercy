import { colorNames, face, kindNames, type Card } from "../shared/types";
const inks = {
  red: "#ed1c24",
  yellow: "#f8cf00",
  green: "#009b49",
  blue: "#0075be",
};
function symbol(c: Card): string {
  const ink = c.color ? inks[c.color] : "#fff";
  if (c.kind === "skip" || c.kind === "skipAll")
    return `<g fill="none" stroke="${ink}" stroke-width="7"><circle cx="50" cy="73" r="21"/><path d="M35 88L65 58"/>${c.kind === "skipAll" ? '<circle cx="50" cy="73" r="29" stroke-width="3"/>' : ""}</g>`;
  if (c.kind === "reverse")
    return `<g fill="${ink}" stroke="#111" stroke-width="1" transform="rotate(-30 50 75)"><path d="M26 91V66q0-12 12-12h11V43l20 18-20 18V68h-9v23z"/><path d="M74 59v25q0 12-12 12H51v11L31 89l20-18v11h9V59z"/></g>`;
  if (c.kind === "roulette")
    return '<g stroke="white" stroke-width="2"><path fill="#ed1c24" d="M50 75V48a27 27 0 0 1 27 27z"/><path fill="#0075be" d="M50 75h27a27 27 0 0 1-27 27z"/><path fill="#009b49" d="M50 75v27a27 27 0 0 1-27-27z"/><path fill="#f8cf00" d="M50 75H23a27 27 0 0 1 27-27z"/></g>';
  if (c.kind === "discardAll")
    return `<g fill="${ink}" stroke="#161616" stroke-width="1.2"><rect x="25" y="48" width="25" height="39" rx="3" transform="rotate(-12 38 67)"/><rect x="43" y="52" width="25" height="39" rx="3" transform="rotate(10 55 71)"/><path d="M41 91h8V79h10v12h8l-13 15z"/></g>`;
  if (!c.color) {
    return `<g transform="rotate(18 50 75)" stroke="white" stroke-width="2"><rect x="18" y="60" width="20" height="32" rx="3" fill="#ed1c24"/><rect x="32" y="52" width="20" height="32" rx="3" fill="#0075be"/><rect x="47" y="60" width="20" height="32" rx="3" fill="#009b49"/><rect x="62" y="52" width="20" height="32" rx="3" fill="#f8cf00"/></g><text x="50" y="115" class="wild-value" text-anchor="middle" fill="white" stroke="#111" stroke-width="3" paint-order="stroke">${face(c)}</text>`;
  }
  return `<text x="50" y="98" text-anchor="middle" fill="${ink}" stroke="#111" stroke-width="2" paint-order="stroke" class="uno-value">${face(c)}</text>${c.kind === "number" && (c.value === 6 || c.value === 9) ? `<path d="M37 105h26" stroke="${ink}" stroke-width="3"/>` : ""}`;
}
/** Original vector reconstruction of the familiar UNO card layout. */
export function cardMarkup(
  c: Card,
  button = false,
  enabled = false,
  fresh = false,
) {
  const label = `${c.color ? colorNames[c.color] : "万能"} ${c.kind === "number" ? c.value : kindNames[c.kind]}`;
  const back = c.color ? inks[c.color] : "#151515";
  const corners =
    c.kind === "number" ||
    ["draw2", "draw4", "wild4", "wild6", "wild10"].includes(c.kind)
      ? face(c)
      : c.kind === "reverse"
        ? "⇄"
        : c.kind === "discardAll"
          ? "⇊"
          : c.kind === "roulette"
            ? "◉"
            : "⊘";
  return `<${button ? "button" : "div"} class="card uno-card ${c.color ?? "wild"} ${button && !enabled ? "unplayable" : ""}" ${button ? `data-card="${c.id}" ${enabled ? "" : "disabled"}` : ""} aria-label="${label}" title="${label}"><svg class="card-art" viewBox="0 0 100 150" aria-hidden="true"><rect x="1" y="1" width="98" height="148" rx="12" fill="#111"/><rect x="5" y="5" width="90" height="140" rx="9" fill="white"/><rect x="8" y="8" width="84" height="134" rx="7" fill="${back}"/><ellipse cx="50" cy="75" rx="31" ry="57" transform="rotate(28 50 75)" fill="${c.color ? "white" : "#242424"}" stroke="white" stroke-width="2"/>${symbol(c)}<g fill="white" stroke="#111" stroke-width=".6" paint-order="stroke" class="uno-corner"><text x="12" y="29">${corners}</text><text x="12" y="29" transform="rotate(180 50 75)">${corners}</text></g></svg>${c.kind !== "number" ? `<span class="uno-action-label">${kindNames[c.kind]}</span>` : ""}${button && fresh ? '<span class="new-card-tag">新牌</span>' : ""}</${button ? "button" : "div"}>`;
}
