# Smart categories classifier design

Date: 2026-07-09

## Summary

GatherLocal should add hands-off learned smart categories for saved items. Smart categories are not manual tags or folders. They are adaptive, weighted lenses over the library that help users rediscover groups of related saves without requiring up-front organization.

The classifier should learn category names and subtopics from the user's actual library, assign saves to multiple categories with confidence weights, and periodically refresh the taxonomy when the library changes enough. The system should keep category identity stable, avoid visible churn, and only surface recent changes through a small history/info icon on changed category rows.

## Goals

- Learn categories automatically from the library rather than from a fixed taxonomy.
- Support adaptive structure: categories start flat and can develop subtopics when enough related saves exist.
- Assign one save to multiple smart categories with weights.
- Use weak or missing X bookmark context safely by reading image content, OCR, tweet text, and other available evidence.
- Keep user-facing category names stable while allowing conservative improvement over time.
- Avoid polluting manual tags, collections, or boards.
- Run in the background only when app activity is quiet.
- Keep search forgiving through category aliases and semantic expansion.

## Non-goals

- Replacing manual tags, collections, or boards.
- Creating or modifying user tags/folders automatically.
- Showing a full activity feed or noisy changelog for classifier decisions.
- Guaranteeing every save belongs to a visible smart category.
- Building a fixed universal category taxonomy.

## Existing context

GatherLocal already has:

- X bookmark import, where X saves currently receive a generic `bookmark` tag.
- AI indexing on save, including image analysis, title/description/OCR fields, and embeddings.
- Search that combines structured filters, semantic embeddings, literal text matches, tag matches, and color matches.
- Manual per-save tags and collection membership.

Smart categories should build on these pieces rather than introduce a separate source of truth for save content.

## Core concept

Smart categories are weighted saved-search-like lenses, not folders.

```text
Save: tweet about using image AI to make ad concepts

Smart category memberships:
  AI image generation        0.91
  Ad creative workflows      0.76
  Design inspiration         0.58
  Marketing systems          0.42
```

The same save can appear in more than one category. Category pages rank members by score, recency, and category-specific relevance. Low-confidence memberships can help search without making the category page feel noisy.

Suggested thresholds:

```text
>= 0.75  primary membership, visible in category
0.45-0.74 secondary membership, visible lower or behind "also related"
< 0.45   search-only hint, not shown as normal category member
```

## Data model

Exact schema can change during implementation, but the domain should stay close to this shape.

### `smart_categories`

- `id`: stable hidden ID. Never changes across rename.
- `name`: display name.
- `description`: short internal meaning summary.
- `status`: `candidate`, `visible`, `hidden`, `archived`.
- `parent_id`: nullable, for adaptive nesting.
- `centroid_embedding`: representative vector for category meaning.
- `visibility_score`: confidence that this category is useful to show.
- `member_count`: cached visible member count.
- `created_at`, `updated_at`.
- `last_changed_at`: timestamp for recent-change UI.
- `change_kind`: `created`, `renamed`, `merged`, `split`, or null.
- `frozen_name`: user-pinned name should prevent automatic rename.

### `smart_category_aliases`

- `id`
- `category_id`
- `alias`
- `source`: `old_name`, `model_synonym`, `user_language`, `search_synonym`.
- `created_at`

Aliases power search and prevent old names from disappearing after a rename.

### `smart_category_members`

- `category_id`
- `save_id`
- `weight`: 0-1 relevance score.
- `evidence`: compact JSON summary of why this save belongs.
- `assigned_at`
- `updated_at`

Primary key: `(category_id, save_id)`.

### `save_topic_profiles`

- `save_id`
- `concepts`: JSON array of normalized topic concepts.
- `content_type`: e.g. `tweet`, `product screenshot`, `article`, `moodboard`, `diagram`.
- `intent_guess`: e.g. `reference`, `tool`, `tutorial`, `inspiration`, `quote`.
- `summary`: compact classifier-friendly summary.
- `embedding`: optional topic-specific vector if existing save embedding is insufficient.
- `confidence`
- `updated_at`

This is internal fuel. It should not appear as user-facing tags.

### `smart_category_runs`

- `id`
- `run_type`: `incremental_assignment`, `taxonomy_refresh`, `manual_refresh`.
- `started_at`, `finished_at`
- `input_save_count`
- `created_count`, `renamed_count`, `merged_count`, `split_count`
- `failed_count`
- `provider`
- `error`

This supports debugging, throttling, and future settings UI.

## Evidence bundle per save

X bookmarks often have weak context. A save may have no title, and tweet text may not explain an attached image. Classification should build a rich evidence bundle:

```text
Save evidence bundle
  source url
  source type
  tweet text
  quoted tweet text
  thread text if captured
  author name / handle
  user title if present
  manual tags
  collection membership
  OCR text from image
  image vision description
  generated topic concepts
  existing embedding
```

If image content exists but image analysis has not run, smart categorization should wait for or request analysis rather than classify from tweet text alone.

## Category churn control

The classifier must avoid making the library feel like it reorganizes itself every day.

Bad behavior:

```text
Day 1:
  [AI tools]

Day 5:
  [Workflow automation]

Day 10:
  [AI design workflows]
```

Better behavior:

```text
Stable hidden ID:
  cat_7f92

Display name:
  "AI tools"

Refresh sees possible better name:
  "AI workflow tools"

Decision:
  confidence high?     yes
  cooldown passed?     yes
  name not frozen?     yes

Apply:
  cat_7f92.name = "AI workflow tools"
  aliases += ["AI tools"]
  last_changed_at = now
  change_kind = "renamed"
```

Old names become aliases. Recent changes show a tiny info/history icon on the category row. Hover or click can reveal a compact reason:

```text
Renamed from "AI tools". Old name still works in search.
```

## Refresh strategy

Use two refresh types.

### Incremental assignment

Purpose: place new saves into existing categories or candidate groups.

Trigger:

- at least 25 new or pending saves since last run by default
- no active capture/import events for 3 minutes
- no active typing/searching/editing/dragging/modal work
- AI provider available
- rate limited

Behavior:

1. Build topic profiles for pending saves.
2. Compare save embeddings and topic concepts to existing category centroids.
3. Assign high-confidence category memberships.
4. Cluster leftovers into candidate groups.
5. Keep small or weak clusters hidden until they are useful.

### Taxonomy refresh

Purpose: reconsider names, aliases, merges, splits, and parent/child structure.

Trigger:

- every 150 new saves, or
- every 14 days when at least 50 new saves exist, or
- user clicks `Refresh smart categories`

Behavior:

1. Recompute category centroids from current members.
2. Detect overlapping categories.
3. Detect broad categories with clear subclusters.
4. Ask model to propose names, aliases, merge candidates, and split candidates.
5. Apply only conservative changes that pass stability rules.

## Background opportunity policy

Smart categorization can run only when it should not interrupt the user.

An opportunity exists when:

- no save/import burst is active
- no new capture has arrived for 3 minutes
- user is not typing in search or tag fields
- user is not editing details
- no modal workflow is open
- no drag/drop interaction is active
- semantic/AI provider is available
- refresh is not rate-limited
- enough pending saves exist, unless manually requested

If the user becomes active during work, pause or finish the current small batch and defer remaining work.

## Learned naming

Category names should come from the library, not from a fixed taxonomy.

Naming input:

- top representative saves
- repeated terms from tweet text, OCR, vision summaries, manual tags, and existing user naming
- sibling categories, so labels do not overlap
- universal synonyms for aliases

Name selection should prefer:

- specific enough to separate from siblings
- broad enough to survive future saves
- readable as navigation
- not overly generic, e.g. avoid `tools`, `ideas`, `design` alone when siblings need more detail

Example:

```text
Cluster meaning:
  AI tools that automate tasks across apps

Display name:
  AI workflow tools

Aliases:
  AI automation
  workflow ops
  agents
  productivity AI
  automation tools
```

## Adaptive hierarchy

Start flat. Introduce nesting only when the library proves it needs it.

Create child categories when:

- parent category is large enough
- subclusters are clear and stable
- child names are more useful than filters alone
- child categories have enough visible members

Do not show a parent/child structure just because the model can imagine one.

Example:

```text
Flat early state:
  AI workflow tools
  Visual generation tools
  SaaS UI examples

Later adaptive state:
  AI
    Workflow tools
    Image generation
    Agent patterns
  Design
    SaaS UI examples
    Landing page references
```

## Search behavior

Smart categories should make search more forgiving.

Search pipeline should include:

1. direct title/source/tweet/OCR search
2. semantic save search
3. manual tag search
4. smart category name and alias search
5. expansion from matching smart categories into member saves

Example:

```text
Category:
  name: "Visual generation tools"
  aliases: ["AI design", "image AI", "design AI", "generative design"]

Search:
  "AI design"

Result:
  direct save matches first
  then high-confidence members of "Visual generation tools"
  optional chip: Smart category: Visual generation tools
```

## UI behavior

Add a Smart categories surface to the sidebar/navigation area below Saved/Search and above manual collections.

Rows should feel like quiet navigation:

```text
Smart categories
  AI workflow tools          42
  Visual generation tools    31  i
  SaaS UI examples           28
  Ad creative workflows      19
```

The small `i` icon appears only when the category changed recently. It disappears after a time window or after the user views the change note.

Category details may show:

- representative saves
- member count
- related categories
- hide category
- pin category name
- refresh category

No noisy global changelog by default.

## Visibility rules

Categories should be visible only when useful.

Candidate categories stay hidden when:

- member count below threshold
- average confidence too low
- name is vague
- cluster is too close to an existing category
- category is mostly stale one-off material

Visible categories require:

- enough high-confidence members
- a stable readable name
- meaningful separation from siblings
- positive evidence that navigation improves

## Error handling

- If AI provider unavailable: mark smart categorization as pending and retry later.
- If image analysis fails: classify from available evidence only if confidence is high enough; otherwise leave pending.
- If taxonomy refresh fails midway: keep previous taxonomy and write failed run metadata.
- If model returns invalid JSON: reject run output, keep old state, record error.
- If a proposed merge/split/rename conflicts with frozen user choice: skip that change.

## Settings and controls

Minimum controls:

- toggle smart categories on/off
- refresh smart categories now
- hide a category
- pin category name
- reset smart categories and rebuild

Settings should not over-explain privacy. Since this is a local app, keep copy practical:

```text
Smart categories learn from saved content and run in the background when the app is idle.
```

## Testing plan

Unit tests:

- category visibility thresholds
- membership score thresholds
- rename cooldown and alias creation
- merge/split guardrails
- idle opportunity policy
- search alias expansion

Database tests:

- migration creates smart category tables
- deleting a save cleans membership rows
- deleting/archiving category handles aliases and memberships
- old names remain searchable through aliases

Classifier fixtures:

- weak X bookmark with image-only meaning categorizes from vision/OCR evidence
- one save can receive multiple category memberships
- repeated refresh preserves stable category ID
- low-confidence clusters remain hidden candidates
- category rename creates alias and recent-change metadata

UI tests:

- recent-change icon appears only on recently changed categories
- hidden/candidate categories do not appear in navigation
- pinned category name does not auto-rename
- search for alias returns category-expanded results

## Implementation defaults

These defaults should be treated as starting values and tuned with fixtures and real-library testing.

- Incremental assignment threshold: 25 pending saves.
- Taxonomy refresh threshold: 150 new saves or 14 days with at least 50 new saves.
- Capture quiet window: 3 minutes after last save/import event.
- Rename cooldown: 14 days per category.
- Recent-change icon lifetime: 7 days or until viewed.
- Visible category minimum: 5 high-confidence members.
- Primary membership threshold: 0.75.
- Secondary membership threshold: 0.45.
- Candidate category minimum: 3 related saves.
- Default Smart categories placement: sidebar/navigation area below Saved/Search and above manual collections.
- Secondary memberships: show behind an "also related" section inside category detail, not in the main category grid by default.
- Hide/pin controls: row context menu for quick actions, category detail panel for explanatory actions.

## Recommended first implementation slice

1. Add schema and storage APIs for smart categories, aliases, topic profiles, memberships, and runs.
2. Add deterministic classifier scaffolding that can assign saves to fixture categories using existing embeddings.
3. Add background opportunity scheduler with no model calls yet.
4. Add minimal Smart categories navigation and category result view.
5. Add model-backed topic profiling and category naming.
6. Add taxonomy refresh guardrails for rename/alias first; defer merge/split until assignments are stable.

This sequence proves the product behavior before allowing the classifier to rewrite taxonomy structure.
