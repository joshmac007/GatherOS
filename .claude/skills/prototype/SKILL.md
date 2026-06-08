---
name: prototype
description: Explore a concept by generating five genuinely distinct design iterations and packaging them into one self-contained, easy-to-navigate HTML document. Use whenever the user wants to prototype, mock up, sketch, or compare multiple design directions for a UI, screen, component, flow, layout, landing page, or visual concept.
---

# Prototype — five iterations, one HTML doc

When this skill runs, the user has given you a **concept** to prototype (in
their message / the arguments to the skill). Turn it into **five genuinely
different design iterations**, rendered as real HTML/CSS mockups, and deliver
them in a **single self-contained HTML file** the user can double-click to open.

If the concept is too vague to design against (e.g. no idea of audience,
platform, or purpose), ask 1–2 quick clarifying questions first. Otherwise make
reasonable assumptions, state them, and proceed — don't stall.

## What "5 iterations" means
Each iteration is a distinct **direction**, not a recolor of the same layout.
Across the five, vary things like:
- layout & information hierarchy
- interaction / navigation model
- visual style (minimal, editorial, playful, dense pro-tool, brutalist, etc.)
- the core framing or idea of the concept

Give each iteration a short name and a one-to-two-sentence rationale ("why this
direction, who it's for").

## The deliverable: one HTML file
- **Single file, fully self-contained.** All CSS and JS inline. No external
  links, CDNs, web fonts, or remote images — it must render correctly offline.
  Use system fonts and inline SVG / emoji for any visuals.
- **Easy to navigate.** A fixed top bar (or left rail) lists the five iterations
  as tabs labelled `1 … 5` plus their names. Clicking a tab — or pressing keys
  `1`–`5` — swaps to that iteration full-bleed. Above each mockup show its name
  and rationale.
- **Each iteration is an actual mockup**, not a description of one: realistic
  placeholder content, hover/click states where they help, laid out as the real
  thing would look.
- Clean, modern styling; looks right at common screen widths.
- Document `<title>` and the page `<h1>` are the concept itself.

## Steps
1. Restate the concept in one line so the user can confirm you understood it.
2. Brainstorm five distinct directions internally; sanity-check they're
   meaningfully different before building.
3. Build the single HTML file using the structure above.
4. Save it to `prototypes/<concept-slug>.html` (create the `prototypes/` folder
   if needed; `<concept-slug>` is a short kebab-case version of the concept).
5. Report the exact path and the open command, e.g.
   `open prototypes/<concept-slug>.html` on macOS.

## Quality bar
- Opens to iteration 1 with no console errors.
- Tab clicks and number-key (1–5) switching both work.
- The five iterations are visually distinguishable at a glance.
- Sentence case for headings, labels, and buttons (not Title Case).
