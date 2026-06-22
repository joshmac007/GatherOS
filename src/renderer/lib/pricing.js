// Single source of truth for the subscription prices shown in the UI
// (paywall, upgrade modal, account settings). Keep these in sync with
// the Lemon Squeezy variants the Worker checks out — the values here are
// display-only; the real charge comes from Lemon Squeezy.

export const PRICING = {
  monthly: { price: '$4.99', unit: '/mo', label: 'Monthly' },
  yearly: { price: '$49', unit: '/yr', label: 'Yearly' },
};

// Rounded headline savings for the yearly plan vs. paying monthly.
export const YEARLY_SAVINGS = '~18%';

// "$4.99/mo · $49/yr" — a compact both-plans summary for the account page.
export function priceSummary() {
  const m = PRICING.monthly;
  const y = PRICING.yearly;
  return `${m.price}${m.unit} · ${y.price}${y.unit}`;
}
