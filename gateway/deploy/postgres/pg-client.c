/* Private connection input for PostgreSQL clients. Resolve mode emits only to
 * its caller's pipe; POSIX wrappers replace themselves with the admitted tool. */
#define _POSIX_C_SOURCE 200809L
#include <libpq-fe.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

#define CONNECTION_LIMIT (1024U * 1024U)
#define METADATA_LIMIT (4U * 1024U * 1024U - 128U)
#define MARKER "--hgw-connection-stdin-v1="

static int fail(const char *message) {
    fprintf(stderr, "hgw-pg-client: %s\n", message);
    return 1;
}

static int valid_nonce(const char *value) {
    return strlen(value) == 32 && strspn(value, "0123456789abcdef") == 32;
}

static int read_all(void *output, size_t length) {
    unsigned char *cursor = output;
    while (length > 0) {
#ifdef _WIN32
        int count = _read(0, cursor, (unsigned int) length);
#else
        ssize_t count = read(STDIN_FILENO, cursor, length);
#endif
        if (count <= 0) return 0;
        cursor += count;
        length -= (size_t) count;
    }
    return 1;
}

static PGconn *read_connection(void) {
    unsigned char header[4];
    if (!read_all(header, sizeof(header))) return NULL;
    uint32_t length = ((uint32_t) header[0] << 24) | ((uint32_t) header[1] << 16)
        | ((uint32_t) header[2] << 8) | header[3];
    if (length == 0 || length > CONNECTION_LIMIT) return NULL;
    char *input = calloc((size_t) length + 1, 1);
    if (input == NULL) return NULL;
    if (!read_all(input, length) || memchr(input, 0, length) != NULL) {
        free(input);
        return NULL;
    }
    char *error = NULL;
    PQconninfoOption *parsed = PQconninfoParse(input, &error);
    if (parsed == NULL) {
        PQfreemem(error);
        free(input);
        return NULL;
    }
    PQconninfoFree(parsed);
    PGconn *connection = PQconnectStart(input);
    free(input);
    if (connection != NULL && PQstatus(connection) == CONNECTION_BAD) {
        PQfinish(connection);
        return NULL;
    }
    return connection;
}

int main(int argc, char **argv) {
#ifdef _WIN32
    if (_setmode(0, _O_BINARY) == -1 || _setmode(1, _O_BINARY) == -1) return fail("binary pipe setup failed");
#endif
    if (argc == 2 && strcmp(argv[1], "--protocol-version") == 0) {
        puts("hgw-pg-client/1");
        return 0;
    }
    const int resolve = argc == 3 && strcmp(argv[1], "--resolve-stdin-v1") == 0;
    const char *nonce = resolve ? argv[2] : NULL;
    int marker = -1;
    if (!resolve) {
        if (argc < 2) return fail("a PostgreSQL client command is required");
        for (int index = 2; index < argc; index++) {
            if (strncmp(argv[index], MARKER, strlen(MARKER)) != 0) continue;
            if (marker != -1) return fail("duplicate private input marker");
            marker = index;
            nonce = argv[index] + strlen(MARKER);
        }
    }
    if (nonce != NULL && !valid_nonce(nonce)) return fail("invalid private input marker");
#ifdef _WIN32
    if (!resolve) return fail("wrapped clients require a POSIX execution host");
#else
    if (nonce == NULL) {
        execvp(argv[1], argv + 1);
        return fail("PostgreSQL client could not start");
    }
#endif
    PGconn *connection = read_connection();
    if (connection == NULL) return fail("invalid connection input or initial connection failed");
    PQconninfoOption *options = PQconninfo(connection);
    if (options == NULL) {
        PQfinish(connection);
        return fail("connection options unavailable");
    }
    size_t total = 0;
    for (PQconninfoOption *option = options; option->keyword != NULL; option++) {
        if (option->val == NULL) continue;
        if (option->val[0] != 0 && strcmp(option->keyword, "password") != 0
            && ((option->dispchar != NULL && strchr(option->dispchar, '*') != NULL)
                || strcmp(option->keyword, "scram_client_key") == 0
                || strcmp(option->keyword, "scram_server_key") == 0)) {
            PQconninfoFree(options);
            PQfinish(connection);
            return fail("this credential requires a private maintenance provider; client arguments are refused");
        }
        size_t key = strlen(option->keyword), value = strlen(option->val);
        if (key > METADATA_LIMIT || value > METADATA_LIMIT - 2 || total > METADATA_LIMIT - key
            || total + key > METADATA_LIMIT - value - 2) {
            PQconninfoFree(options);
            PQfinish(connection);
            return fail("connection options exceed the private input limit");
        }
        total += key + value + 2;
    }
    if (resolve) {
        int ok = printf("hgw-pg-client/1 %s %d\n", nonce, PQlibVersion()) > 0;
        for (PQconninfoOption *option = options; option->keyword != NULL && ok; option++) {
            if (option->val == NULL) continue;
            ok = fwrite(option->keyword, strlen(option->keyword) + 1, 1, stdout) == 1
                && fwrite(option->val, strlen(option->val) + 1, 1, stdout) == 1;
        }
        PQconninfoFree(options);
        PQfinish(connection);
        return ok && fflush(stdout) == 0 ? 0 : fail("private options output failed");
    }
#ifndef _WIN32
    char *safe = calloc(2 * total + 1, 1), *cursor = safe;
    if (safe == NULL) {
        PQconninfoFree(options);
        PQfinish(connection);
        return fail("connection allocation failed");
    }
    const char *password = NULL;
    for (PQconninfoOption *option = options; option->keyword != NULL; option++) {
        if (option->val == NULL || strcmp(option->keyword, "service") == 0) continue;
        if (strcmp(option->keyword, "password") == 0) { password = option->val; continue; }
        size_t length = strlen(option->keyword);
        memcpy(cursor, option->keyword, length); cursor += length;
        *cursor++ = '='; *cursor++ = '\'';
        for (const char *value = option->val; *value; value++) {
            if (*value == '\\' || *value == '\'') *cursor++ = '\\';
            *cursor++ = *value;
        }
        *cursor++ = '\''; *cursor++ = ' ';
    }
    int changed = password == NULL ? unsetenv("PGPASSWORD") : setenv("PGPASSWORD", password, 1);
    if (changed != 0 || unsetenv("PGSERVICE") != 0) {
        free(safe); PQconninfoFree(options); PQfinish(connection);
        return fail("private client environment failed");
    }
    PQconninfoFree(options);
    PQfinish(connection);
    char **command = calloc((size_t) argc + 3, sizeof(char *));
    if (command == NULL) { free(safe); return fail("client allocation failed"); }
    int count = 0;
    for (int index = 1; index < argc; index++) if (index != marker) command[count++] = argv[index];
    command[count++] = "--dbname";
    command[count] = safe;
    if (printf("hgw-pg-client/1 %s\n", nonce) > 0 && fflush(stdout) == 0) execvp(command[0], command);
    free(command); free(safe);
    return fail("PostgreSQL client could not start");
#else
    PQconninfoFree(options);
    PQfinish(connection);
    return fail("unsupported client mode");
#endif
}
