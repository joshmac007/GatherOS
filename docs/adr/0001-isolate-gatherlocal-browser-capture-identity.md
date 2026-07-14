# Isolate GatherLocal browser capture identity

GatherLocal ships a distinct browser extension, native-messaging host, capture port, deep-link scheme, app ID, and user-data root. A shared extension with target selection was rejected because it couples GatherLocal to upstream and makes install order or mutable router state decide which library receives a save; fixed one-to-one identities let GatherOS and GatherLocal coexist without rewriting or reading each other's state.

## Consequences

GatherLocal uses its own committed extension public key and stable ID, `co.gatherlocal.host`, `127.0.0.1:53248`, `gatherlocal://`, `com.gatherlocal.app`, and Electron's `GatherLocal` data/log roots. Internal extension message names may retain `gatheros:*` protocol vocabulary because distinct extension origins isolate them.

Fresh magic-link sign-in also requires an auth callback that explicitly supports `gatherlocal://`; GatherLocal will not claim `gatheros://` as a compatibility fallback. Existing upstream-session verification and callback provisioning are separate concerns.
