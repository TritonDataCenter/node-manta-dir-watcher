# node-manta-dir-watcher Changelog

## not yet released

(nothing yet)


## 1.3.0

- Add `mwatchdir --first ...` option to exit after the first event.


## 1.2.0

- Add `oneShot` boolean option to `MantaDirWatcher` to do a single poll and then close.
  Add `--one-shot, -1` CLI option to `mwatchdir` for this. This is only useful when
  also using syncDir so that there is a local dir against which to compare content
  for the single poll results.

## 1.1.0

- Fix handling for `clientOpts` option to `MantaDirWatcher`.
- Add `<watcher>.poke()` to poll immediately.


## 1.0.0

Initial release.
