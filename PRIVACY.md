# GatherLocal privacy policy

_Last updated: July 20, 2026_

GatherLocal is a local-first desktop app for saving, browsing, and organizing visual references. Almost nothing leaves your machine; optional network features send only data needed for work you enable or request.

Questions: [hey@gatheros.co](mailto:hey@gatheros.co).

## What we do not do

- We do not run a GatherLocal service that collects or analyzes your library.
- We do not sell data, show ads, or collect analytics or telemetry.
- We do not require a GatherLocal account. Optional ChatGPT Codex features require signing in to ChatGPT.

## Where your library lives

Saves, collections, tags, notes, thumbnails, settings, and local app state live under:

```text
~/Library/Application Support/GatherLocal/
```

GatherLocal does not upload this folder. **Erase library** removes library data; **Export library as zip** writes a portable copy.

## ChatGPT Codex sign-in

GatherLocal can use your ChatGPT subscription for optional structured AI features. Sign-in uses OpenAI OAuth with an exact localhost callback.

- OAuth tokens are stored as ciphertext in `codex-auth.vault`. Electron `safeStorage`, backed by macOS Keychain, encrypts and decrypts that ciphertext.
- Tokens are sent only to `auth.openai.com` for authentication and `chatgpt.com` for enabled Codex requests. GatherLocal has no token proxy.
- Tokens and credentials are excluded from GatherLocal library exports and snapshots. System-level backups may still contain encrypted vault ciphertext.
- **Settings → Local AI → Log out** removes saved ChatGPT credentials and cancels active AI requests.

## Data sent for AI features

When ChatGPT Codex features are enabled, GatherLocal sends relevant images and text directly to OpenAI. This can include image bytes, extracted or user-written text, titles, descriptions, tags, and prompts needed for the selected feature.

- **Auto-name new uploads** and background image analysis send newly saved images when enabled.
- **Auto-tag** and **Image prompts** send the selected image when you invoke them.
- Smart-category work can send relevant save text and image-derived metadata when enabled.
- Semantic embeddings use the locally configured embedding provider by default; its data handling depends on that provider.

OpenAI handles submitted data under its [terms of use](https://openai.com/policies/terms-of-use) and [privacy policy](https://openai.com/policies/privacy-policy). Leave ChatGPT disconnected and use local providers to avoid Codex requests.

## Browser extension and imported services

The browser extension sends captures to the GatherLocal desktop app over local native messaging. X and Instagram imports access those services through your browser session. URL and image capture contacts the source URL you request. Those services may log normal network request information under their own policies.

## Auto-updates

GatherLocal checks GitHub Releases over HTTPS. GitHub may log standard request information; GatherLocal adds no analytics identifier.

## Images, errors, and backups

Original files and thumbnails stay in the GatherLocal application-data directory. GatherLocal does not automatically upload crash reports or error logs. GatherLocal exports and snapshots exclude credentials, but macOS or other whole-system backups may include the encrypted OAuth vault.

## Changes

Material changes update this document and its date. Current policy is available in **Settings → About → Privacy** and on the [GatherLocal local branch](https://github.com/joshmac007/GatherOS/blob/local/PRIVACY.md).
