/* POSIX directory handles: worker-owned syscalls and descriptor-relative traversal. */
#define _POSIX_C_SOURCE 200809L
#define _GNU_SOURCE
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/attr.h>
#endif

#ifdef __linux__
#define DIRECTORY_ACCESS O_PATH
#else
#define DIRECTORY_ACCESS O_SEARCH
#endif

typedef struct {
  int fd;
  DIR *reader;
  struct stat identity;
  bool busy;
  bool ended;
} directory_handle;

typedef enum { OPEN_PATH, OPEN_CHILD, READ, MKDIR, CLOSE, VOLUME } directory_operation;
typedef struct {
  char *name;
  bool directory;
  bool symlink;
} directory_entry;

typedef struct {
  napi_env env;
  napi_ref callback;
  napi_ref owner;
  napi_async_work work;
  napi_async_cleanup_hook_handle cleanup;
  directory_operation operation;
  directory_handle *handle;
  directory_handle *opened;
  char *path;
  directory_entry *entries;
  size_t capacity;
  size_t length;
  int error;
  bool closing;
  unsigned char volume[16];
  bool has_volume;
} directory_request;

static const napi_type_tag directory_tag = { UINT64_C(0xf83984e932aa474e), UINT64_C(0x9cbb2e4a5731c8d4) };

static void checked(napi_status status) {
  if (status != napi_ok) napi_fatal_error("directory", NAPI_AUTO_LENGTH, "Node-API directory operation failed", NAPI_AUTO_LENGTH);
}

static int close_handle(directory_handle *handle) {
  int error = 0;
  if (handle->reader != NULL) {
    DIR *reader = handle->reader;
    handle->reader = NULL;
    if (closedir(reader) != 0) error = errno;
  }
  if (handle->fd >= 0) {
    int fd = handle->fd;
    handle->fd = -1;
    if (close(fd) != 0 && error == 0) error = errno;
  }
  return error;
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  directory_handle *handle = data;
  /* Every queued operation retains its object until its worker has finished. */
  (void)close_handle(handle);
  free(handle);
}

static void release_request(directory_request *request) {
  if (request->handle != NULL) request->handle->busy = false;
  if (request->opened != NULL) {
    (void)close_handle(request->opened);
    free(request->opened);
  }
  for (size_t i = 0; i < request->length; i++) free(request->entries[i].name);
  free(request->entries);
  free(request->path);
  if (request->owner != NULL) (void)napi_delete_reference(request->env, request->owner);
  if (request->callback != NULL) (void)napi_delete_reference(request->env, request->callback);
  if (request->work != NULL) (void)napi_delete_async_work(request->env, request->work);
  if (request->cleanup != NULL) (void)napi_remove_async_cleanup_hook(request->cleanup);
  free(request);
}

static napi_value setup_error(napi_env env, directory_request *request, const char *message) {
  release_request(request);
  bool pending;
  checked(napi_is_exception_pending(env, &pending));
  if (!pending) (void)napi_throw_error(env, "ERR_DIRECTORY_ASYNC_WORK", message);
  return NULL;
}

static void execute_directory(napi_env env, void *data) {
  (void)env;
  directory_request *request = data;
  directory_handle *handle = request->handle;
  if (request->operation != OPEN_PATH && handle->fd < 0) {
    request->error = EBADF;
    return;
  }
  switch (request->operation) {
    case OPEN_PATH:
    case OPEN_CHILD: {
      int flags = DIRECTORY_ACCESS | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
      int fd = request->operation == OPEN_PATH ? open(request->path, flags) : openat(handle->fd, request->path, flags);
      if (fd < 0) { request->error = errno; return; }
      directory_handle *opened = calloc(1, sizeof(*opened));
      if (opened == NULL) { request->error = ENOMEM; (void)close(fd); return; }
      opened->fd = fd;
      request->opened = opened;
      if (fstat(fd, &opened->identity) != 0) request->error = errno;
      return;
    }
    case MKDIR:
      if (mkdirat(handle->fd, request->path, 0777) != 0) request->error = errno;
      return;
    case CLOSE:
      request->error = close_handle(handle);
      return;
    case VOLUME: {
#ifdef __APPLE__
      struct attrlist attributes = { .bitmapcount = ATTR_BIT_MAP_COUNT, .volattr = ATTR_VOL_INFO | ATTR_VOL_UUID };
      struct { uint32_t length; unsigned char uuid[16]; } result = {0};
      if (fgetattrlist(handle->fd, &attributes, &result, sizeof(result), 0) != 0) {
        request->error = errno;
        return;
      }
      if (result.length != sizeof(result)) { request->error = EIO; return; }
      memcpy(request->volume, result.uuid, sizeof(request->volume));
      for (size_t i = 0; i < sizeof(request->volume); i++) {
        if (request->volume[i] != 0) request->has_volume = true;
      }
#endif
      return;
    }
    case READ:
      break;
  }
  if (handle->ended) return;
  if (handle->reader == NULL) {
    /* dup would share the parent's directory offset with other readers. */
    int fd = openat(handle->fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) { request->error = errno; return; }
    handle->reader = fdopendir(fd);
    if (handle->reader == NULL) { request->error = errno; (void)close(fd); return; }
  }
  request->entries = calloc(request->capacity, sizeof(*request->entries));
  if (request->entries == NULL) { request->error = ENOMEM; return; }
  while (request->length < request->capacity) {
    /* EOF and errors are distinguished on the same worker as readdir. */
    errno = 0;
    struct dirent *entry = readdir(handle->reader);
    if (entry == NULL) {
      request->error = errno;
      if (request->error == 0) handle->ended = true;
      return;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    bool directory = entry->d_type == DT_DIR, symlink = entry->d_type == DT_LNK;
    if (entry->d_type == DT_UNKNOWN) {
      struct stat info;
      if (fstatat(handle->fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
        int error = errno;
        if (error == ENOENT) continue;
        request->error = error;
        return;
      }
      directory = S_ISDIR(info.st_mode);
      symlink = S_ISLNK(info.st_mode);
    }
    directory_entry *copy = &request->entries[request->length];
    copy->name = strdup(entry->d_name);
    if (copy->name == NULL) { request->error = ENOMEM; return; }
    copy->directory = directory;
    copy->symlink = symlink;
    request->length++;
  }
}

static napi_status handle_value(napi_env env, directory_handle *handle, napi_value *result) {
  napi_value object, device, inode;
  napi_status status = napi_create_object(env, &object);
  if (status == napi_ok) status = napi_type_tag_object(env, object, &directory_tag);
  if (status == napi_ok) status = napi_create_bigint_uint64(env, (uint64_t)handle->identity.st_dev, &device);
  if (status == napi_ok) status = napi_create_bigint_uint64(env, (uint64_t)handle->identity.st_ino, &inode);
  if (status == napi_ok) status = napi_set_named_property(env, object, "device", device);
  if (status == napi_ok) status = napi_set_named_property(env, object, "inode", inode);
  /* Ownership transfers only after every allocating step succeeds. */
  if (status == napi_ok) status = napi_wrap(env, object, handle, finalize_handle, NULL, NULL);
  if (status == napi_ok) *result = object;
  return status;
}

#define COMPLETE_JS(call) do { status = (call); if (status != napi_ok) goto finish; } while (0)
static void complete_directory(napi_env env, napi_status status, void *data) {
  directory_request *request = data;
  if (request->handle != NULL) {
    request->handle->busy = false;
    request->handle = NULL;
  }
  if (env != NULL && !request->closing) {
    if (status != napi_ok) request->error = ECANCELED;
    napi_value callback, receiver, argv[2];
    COMPLETE_JS(napi_get_reference_value(env, request->callback, &callback));
    COMPLETE_JS(napi_get_undefined(env, &receiver));
    COMPLETE_JS(napi_create_int32(env, request->error, &argv[0]));
    COMPLETE_JS(napi_get_undefined(env, &argv[1]));
    if (request->error == 0 && request->opened != NULL) {
      COMPLETE_JS(handle_value(env, request->opened, &argv[1]));
      request->opened = NULL;
    } else if (request->error == 0 && request->operation == VOLUME && request->has_volume) {
      const char hex[] = "0123456789abcdef";
      char uuid[37];
      size_t offset = 0;
      for (size_t i = 0; i < sizeof(request->volume); i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) uuid[offset++] = '-';
        uuid[offset++] = hex[request->volume[i] >> 4];
        uuid[offset++] = hex[request->volume[i] & 15];
      }
      uuid[offset] = '\0';
      COMPLETE_JS(napi_create_string_utf8(env, uuid, offset, &argv[1]));
    } else if (request->error == 0 && request->operation == READ) {
      COMPLETE_JS(napi_create_array_with_length(env, request->length, &argv[1]));
      for (size_t i = 0; i < request->length; i++) {
        napi_value entry, name, directory, symlink;
        COMPLETE_JS(napi_create_object(env, &entry));
        COMPLETE_JS(napi_create_string_utf8(env, request->entries[i].name, NAPI_AUTO_LENGTH, &name));
        COMPLETE_JS(napi_get_boolean(env, request->entries[i].directory, &directory));
        COMPLETE_JS(napi_get_boolean(env, request->entries[i].symlink, &symlink));
        COMPLETE_JS(napi_set_named_property(env, entry, "name", name));
        COMPLETE_JS(napi_set_named_property(env, entry, "isDirectory", directory));
        COMPLETE_JS(napi_set_named_property(env, entry, "isSymbolicLink", symlink));
        COMPLETE_JS(napi_set_element(env, argv[1], (uint32_t)i, entry));
      }
    }
    status = napi_call_function(env, receiver, callback, 2, argv, NULL);
  } else status = napi_ok;
finish:
  release_request(request);
  /* A terminating Worker can refuse object creation before cleanup hooks run. */
  if (env != NULL && status != napi_ok && status != napi_pending_exception) {
    (void)napi_throw_error(env, "ERR_DIRECTORY_COMPLETION", "Cannot construct the directory operation result");
  }
}
#undef COMPLETE_JS

static void cleanup_directory(napi_async_cleanup_hook_handle handle, void *data) {
  (void)handle;
  directory_request *request = data;
  request->closing = true;
  (void)napi_cancel_async_work(request->env, request->work);
}

static napi_value dispatch(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  void *operation;
  checked(napi_get_cb_info(env, info, &argc, argv, NULL, &operation));
  directory_request *request = calloc(1, sizeof(*request));
  if (request == NULL) { (void)napi_throw_error(env, "ENOMEM", "Cannot allocate directory work"); return NULL; }
  request->env = env;
  request->operation = (directory_operation)(intptr_t)operation;
  size_t expected = request->operation == OPEN_PATH || request->operation == CLOSE || request->operation == VOLUME ? 2 : 3;
  napi_valuetype callback_type;
  if (argc != expected || napi_typeof(env, argv[expected - 1], &callback_type) != napi_ok || callback_type != napi_function) {
    return setup_error(env, request, "Directory operation requires a callback");
  }
  if (request->operation != OPEN_PATH) {
    bool tagged = false;
    if (napi_check_object_type_tag(env, argv[0], &directory_tag, &tagged) != napi_ok || !tagged) {
      return setup_error(env, request, "Expected an owned directory handle");
    }
    checked(napi_unwrap(env, argv[0], (void **)&request->handle));
    if (request->handle->busy) {
      request->handle = NULL;
      return setup_error(env, request, "Directory handle already has an operation in progress");
    }
    request->handle->busy = true;
    if (napi_create_reference(env, argv[0], 1, &request->owner) != napi_ok) return setup_error(env, request, "Cannot retain directory handle");
  }
  if (request->operation == OPEN_PATH || request->operation == OPEN_CHILD || request->operation == MKDIR) {
    napi_value value = argv[request->operation == OPEN_PATH ? 0 : 1];
    size_t length;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return setup_error(env, request, "Directory path must be a string");
    request->path = malloc(length + 1);
    if (request->path == NULL) return setup_error(env, request, "Cannot allocate directory path");
    checked(napi_get_value_string_utf8(env, value, request->path, length + 1, &length));
    if (length == 0 || strlen(request->path) != length) return setup_error(env, request, "Directory path must not be empty or contain NUL");
    if (request->operation == OPEN_PATH) {
      if (request->path[0] != '/') return setup_error(env, request, "Directory path must be absolute");
    } else if (strchr(request->path, '/') != NULL || strcmp(request->path, ".") == 0 || strcmp(request->path, "..") == 0) {
      return setup_error(env, request, "Directory child must be one name");
    }
  }
  if (request->operation == READ) {
    double capacity;
    if (napi_get_value_double(env, argv[1], &capacity) != napi_ok || !(capacity >= 1 && capacity <= 65536) || capacity != (size_t)capacity) {
      return setup_error(env, request, "Directory read size must be an integer from 1 to 65536");
    }
    request->capacity = (size_t)capacity;
  }
  napi_value name;
  napi_status status = napi_create_reference(env, argv[expected - 1], 1, &request->callback);
  if (status == napi_ok) status = napi_create_string_utf8(env, "directory", NAPI_AUTO_LENGTH, &name);
  if (status == napi_ok) status = napi_create_async_work(env, NULL, name, execute_directory, complete_directory, request, &request->work);
  if (status == napi_ok) status = napi_add_async_cleanup_hook(env, cleanup_directory, request, &request->cleanup);
  if (status == napi_ok) status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) return setup_error(env, request, "Cannot queue directory work");
  return NULL;
}

napi_value initialize_directory(napi_env env, napi_value exports) {
  const char *names[] = { "directoryOpen", "directoryOpenAt", "directoryRead", "directoryMkdir", "directoryClose", "directoryVolume" };
  for (intptr_t i = OPEN_PATH; i <= VOLUME; i++) {
    napi_value function;
    if (napi_create_function(env, names[i], NAPI_AUTO_LENGTH, dispatch, (void *)i, &function) != napi_ok ||
        napi_set_named_property(env, exports, names[i], function) != napi_ok) return NULL;
  }
  return exports;
}
