/* For the WebAssembly build of GNU grep (build-grep-perl.sh). Emscripten's headers declare splice() and
   SPLICE_F_MOVE, but its C library has no splice(). grep uses it only to skip the rest of a pipe when its output
   goes to /dev/null, and falls back to reading when the call fails with EINVAL – which this one always does. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/types.h>

ssize_t splice (int fd_in, off_t *off_in, int fd_out, off_t *off_out, size_t len, unsigned flags)
{
  (void) fd_in; (void) off_in; (void) fd_out; (void) off_out; (void) len; (void) flags;
  errno = EINVAL;
  return -1;
}
