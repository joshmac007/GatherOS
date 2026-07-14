# GatherLocal

GatherLocal is a personal downstream application that tracks GatherOS source releases while owning separate runtime identity, data, and provider composition.

## Language

**Upstream**:
BrettfromDJ/GatherOS source used as the unmodified release base.
_Avoid_: Vendor tree, original files

**Contribution lane**:
Clean branches based directly on upstream, containing only changes suitable for an upstream pull request.
_Avoid_: Fork branch, shared patch

**Personal overlay**:
Ordered GatherLocal-only commits replayed above an upstream release.
_Avoid_: Local fork, custom build

**Runtime identity**:
Externally visible identifiers that determine which desktop app, extension, native host, local endpoint, and user-data root own an operation.
_Avoid_: Branding, rename

**GatherLocal extension**:
Browser extension whose stable ID and native-host route belong only to GatherLocal.
_Avoid_: Modified GatherOS extension, shared extension

**Sync**:
Integration of a new upstream source release followed by personal-overlay replay and rebuild.
_Avoid_: Binary patch, update merge
