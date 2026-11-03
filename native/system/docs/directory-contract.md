# Directory behavior contract

The `./directory` entry supplies POSIX mechanisms, not authorization. Callers choose an authorized directory and retain every handle until its consumers finish. The Harness browser provider records grant-root identities and verifies its logical paths before publishing results.

## Opened objects

`DirectoryHandle.open(path)` requires an absolute path and retains a search-only descriptor (`O_PATH` on Linux, `O_SEARCH` on macOS) with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK`. Traversal does not require permission to list ancestor contents. Only the final component is excluded from link traversal. To exclude replacement ancestors, open the filesystem root and call `openChild(name)` for each canonical segment. Child opens and creation reject empty names, dot, dot-dot, slash and NUL.

Each handle owns its descriptor; children remain usable after their parent closes. `identity` returns copied device and inode values captured by `fstat`, without transferring native ownership. `createDirectory(name)` runs nonrecursive `mkdirat` against the retained parent with mode 0777 subject to umask. Renaming or replacing the original path does not redirect these operations.

`volumeIdentity()` queries `ATTR_VOL_UUID` with `fgetattrlist` on the retained macOS descriptor. It returns a lowercase filesystem UUID; a zero UUID and other POSIX platforms return absence. Syscall failures reject without substituting a device number or resolving the current path. The query follows ordinary operation ordering and completes before close. A filesystem UUID does not identify a directory or authorize access; persistent consumers also retain inode evidence, and live consumers still verify the opened device/inode against their selected path.

## Enumeration and failures

`read(count)` accepts integers from 1 through 65,536 and returns at most that many entries, including ordinary files. Entries contain names and directory/link flags; link targets are not accessed. The reader uses an independent `openat(fd, ".")` descriptor and `fdopendir`, so it does not share an enumeration offset with another handle. End of directory returns an empty array on subsequent reads. Each worker clears and captures errno around `readdir`, separating EOF from failure.

System calls run in asynchronous Node-API work. Syscall failures reject with code, positive errno and syscall name; invalid arguments, unavailable addons and unsupported platforms reject without a filesystem fallback. No operation compiles a binding at installation or runtime.

## Completion and cleanup

Operations on one handle run serially. `close()` refuses subsequent work and returns the same promise on repeated calls; it closes the reader and descriptor after all previously admitted operations settle. Stopping a caller's wait does not cancel a running syscall or permit early resource release.

Queued work retains its native owner. Environment cleanup waits for running work, closes newly opened descriptors that cannot be delivered, and releases wrapped handles when the environment exits. Native ownership transfers to a JavaScript object only after result construction succeeds; a terminating Worker may refuse object creation before cleanup hooks run.

`test/directory.test.js` exercises retained-object reads and creation, bounded batches, invalid native inputs, ordered close, and forced Worker termination. The Worker cases count references to their own private directory before and after exit. Packed-install verification repeats directory replacement through the installed public entry.
