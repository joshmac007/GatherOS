# GatherLocal

GatherLocal is a personal downstream application that tracks GatherOS source releases while owning separate runtime identity, data, and provider composition.

## Language

**Upstream**:
BrettfromDJ/GatherOS source used as the unmodified release base.
_Avoid_: Vendor tree, original files

**Contribution lane**:
Clean branches based directly on upstream, containing only changes suitable for an upstream pull request.
_Avoid_: Fork branch, shared patch

**Contribution candidate**:
Provider-neutral behavior created in the contribution lane but not yet authorized for external publication.
_Avoid_: Upstreamable change, public patch

**Pending contribution patch**:
A reviewed contribution candidate carried in GatherLocal until upstream adopts, rejects, or supersedes it. It remains distinct from the personal overlay.
_Avoid_: Personal patch, fork change

**Adopted contribution**:
Behavior proven present in a later upstream base, allowing its pending contribution patch to leave GatherLocal's replay stack.
_Avoid_: Merged patch, accepted local change

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
