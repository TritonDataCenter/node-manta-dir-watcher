A node.js library to watch a Manta directory for file changes.

Minimally you give a `MantaDirWatcher` Manta connection & auth info, a Manta
dir to watch, and a period and it will poll the Manta directory and emit an
event each time a file (a.k.a. a Manta object) or directory is added, removed,
or changed.  The sweet spot for this module (currently at least) is a Manta
directory of relatively few (and if using the sync option, relatively small)
files.

Optional features:
- Glob/regex pattern to limit to a subset of files in the dir (via the
  `pattern` option).
- Cache state info between runs (via the `cacheDir` option).
- *Sync* down the files to a local dir (via the `syncDir` option).

Limitations:
- This doesn't handle recursively looking in Manta dirs.

# Install

    npm install manta-dir-watcher

# Usage

```javascript
var MantaDirWatcher = require('manta-dir-watcher');
var watcher = new MantaDirWatcher({
    // Client options:
    url: ...,
    account: ...,   // XXX user? copy node-manta
    insecure: ...,
    keyId: ...,

    dir: <dir to watch>,

    // Optional params:
    cacheDir: <dir in which this can cache info from the last poll>,
    pattern: <glob string or regex to match against file/dir names>,
    syncDir: <local dir to which to sync the dir>,
});

// XXX separte events or just data events? If data events we can just
// easily stream to stdout, right? Try that first
watcher.pipe(process.stdout);
```

# Reference

TODO


# License

MIT. See LICENSE.txt
