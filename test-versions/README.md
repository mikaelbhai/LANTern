# Test versions

Builds put here to be tried on a real device before they are worth a
release. They are debug-signed and universal: one APK that runs on every
processor, which is why it is roughly twice the size of a release split.

Named for the version they report plus the commit they were built from,
because the version alone does not tell you which build you are holding.
`LANTern-1.2.6-ui-89ba2b3.apk` reports 1.2.6 and was built at 89ba2b3.

Anything here is a work in progress. Releases, with the per-processor
packages and the Windows installer, are on the releases page.

## Installing

Download it on the phone and open it. Android asks for permission to
install from LANTern's source the first time, and asks again before
replacing what is already there.

It shares a package name with the release build, so it replaces it and
keeps your settings, library ratings and history. Going back means
installing a release over the top.

## LANTern-1.2.6-ui-89ba2b3.apk

The interface, rebuilt.

- A row in the house list is a person rather than a device. Their
  machines nest underneath, sorted by presence, and actions go to
  whichever one is awake and nearest.
- Sleeping machines are in that list with a wake button, rather than in
  a drawer under it. When all of somebody's devices are asleep, the wake
  is on the person.
- A line under the title bar names a network fault when there is one and
  is absent when there is not.
- Light mode. It defaults to whatever the device is set to. The accent
  and the muted text were both unreadable on a light page and are fixed.
- Four tabs on a phone: house, calls, theatre, games.

The previous interface is on the `ui-v1` branch.
