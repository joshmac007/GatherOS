# GatherOS — Claude notes

## Conventions

- After any code change, always end the reply with the full command to re-run
  the app so the user can copy/paste. Claude's pushes only land in the user's
  local working tree after a `git pull`, so include that explicitly. All
  active development pushes to `main` (the scaffold branch is dormant):

  ```
  cd /Users/brett/GatherOS && git checkout main && git pull origin main && npm run dev
  ```

- Always use **sentence case** for CTAs / button labels / headings — not Title
  Case. ("Export library as zip", not "Export Library as Zip".)
