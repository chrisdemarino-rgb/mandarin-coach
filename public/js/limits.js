// Script length limits (client side). The backend refuses scripts over SCRIPT_MAX characters for script-grounded features.
export const SCRIPT_MAX = 3000;
export const SCRIPT_HINT_MIN = 1000;   // the existing soft "under 1000" hint
/** n = countScriptChars(text) -> {label, under, over, overBy} for the counter + messages. Pure. */
export function scriptLimitInfo(n) {
  const k = Math.max(0, Number(n) || 0);
  return {
    label: `${k.toLocaleString("en-US")} / ${SCRIPT_MAX.toLocaleString("en-US")} characters`,
    under: k > 0 && k < SCRIPT_HINT_MIN,
    over: k > SCRIPT_MAX,
    overBy: Math.max(0, k - SCRIPT_MAX),
  };
}
