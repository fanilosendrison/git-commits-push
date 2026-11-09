/* Test-only VFS shim: schedule real lock promotions; never change their results.
 * Uses SQLite's stable loadable-extension API and the platform SDK headers.
 * No SQLite engine is linked into this extension.
 */
#include <sqlite3ext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
SQLITE_EXTENSION_INIT1

typedef struct {
	sqlite3_file base;
	sqlite3_file *real;
	sqlite3_io_methods methods;
	int main_database;
} ScheduledFile;

static sqlite3_vfs *original_vfs;
static sqlite3_vfs scheduled_vfs;
static const char *role;
static int reserved_seen;

static sqlite3_file *real_file(sqlite3_file *file) {
	return ((ScheduledFile *)file)->real;
}

static void observe(const char *event, int level, int result) {
	dprintf(5, "%s %s %d %d\n", role, event, level, result);
}

static void await_permission(void) {
	char permission;
	if (read(4, &permission, 1) != 1 || permission != 'G') _exit(91);
}

static int close_file(sqlite3_file *file) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xClose(real);
}
static int read_file(sqlite3_file *file, void *buffer, int count, sqlite3_int64 offset) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xRead(real, buffer, count, offset);
}
static int write_file(sqlite3_file *file, const void *buffer, int count, sqlite3_int64 offset) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xWrite(real, buffer, count, offset);
}
static int truncate_file(sqlite3_file *file, sqlite3_int64 size) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xTruncate(real, size);
}
static int sync_file(sqlite3_file *file, int flags) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xSync(real, flags);
}
static int file_size(sqlite3_file *file, sqlite3_int64 *size) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xFileSize(real, size);
}

static int lock_file(sqlite3_file *file, int level) {
	sqlite3_file *real = real_file(file);
	int result = real->pMethods->xLock(real, level);
	if (!((ScheduledFile *)file)->main_database) return result;
	observe("LOCK", level, result);
	if (strcmp(role, "A") == 0 && level == SQLITE_LOCK_RESERVED &&
		result == SQLITE_OK && !reserved_seen) {
		reserved_seen = 1;
		observe("FIRST_RESERVED", level, result);
		await_permission();
	}
	if (strcmp(role, "B") == 0 && level == SQLITE_LOCK_RESERVED &&
		result == SQLITE_BUSY) {
		observe("RESERVED_BUSY", level, result);
		await_permission();
	}
	if (strcmp(role, "A") == 0 && level == SQLITE_LOCK_EXCLUSIVE &&
		result == SQLITE_BUSY) {
		observe("EXCLUSIVE_BUSY", level, result);
		await_permission();
	}
	return result;
}

static int unlock_file(sqlite3_file *file, int level) {
	sqlite3_file *real = real_file(file);
	int result = real->pMethods->xUnlock(real, level);
	if (((ScheduledFile *)file)->main_database) observe("UNLOCK", level, result);
	return result;
}
static int check_reserved(sqlite3_file *file, int *held) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xCheckReservedLock(real, held);
}
static int file_control(sqlite3_file *file, int operation, void *argument) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xFileControl(real, operation, argument);
}
static int sector_size(sqlite3_file *file) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xSectorSize(real);
}
static int device_characteristics(sqlite3_file *file) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xDeviceCharacteristics(real);
}
static int shm_map(sqlite3_file *file, int page, int size, int extend, void volatile **out) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xShmMap(real, page, size, extend, out);
}
static int shm_lock(sqlite3_file *file, int offset, int count, int flags) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xShmLock(real, offset, count, flags);
}
static void shm_barrier(sqlite3_file *file) {
	sqlite3_file *real = real_file(file);
	real->pMethods->xShmBarrier(real);
}
static int shm_unmap(sqlite3_file *file, int remove) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xShmUnmap(real, remove);
}
static int fetch(sqlite3_file *file, sqlite3_int64 offset, int count, void **out) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xFetch(real, offset, count, out);
}
static int unfetch(sqlite3_file *file, sqlite3_int64 offset, void *page) {
	sqlite3_file *real = real_file(file);
	return real->pMethods->xUnfetch(real, offset, page);
}

static int open_file(sqlite3_vfs *vfs, const char *name, sqlite3_file *file,
	int flags, int *out_flags) {
	ScheduledFile *scheduled = (ScheduledFile *)file;
	(void)vfs;
	memset(scheduled, 0, sizeof(*scheduled));
	scheduled->real = (sqlite3_file *)((char *)file + sizeof(*scheduled));
	int result = original_vfs->xOpen(original_vfs, name, scheduled->real, flags, out_flags);
	if (result != SQLITE_OK) return result;
	scheduled->main_database = (flags & SQLITE_OPEN_MAIN_DB) != 0;
	scheduled->methods = *scheduled->real->pMethods;
	scheduled->methods.xClose = close_file;
	scheduled->methods.xRead = read_file;
	scheduled->methods.xWrite = write_file;
	scheduled->methods.xTruncate = truncate_file;
	scheduled->methods.xSync = sync_file;
	scheduled->methods.xFileSize = file_size;
	scheduled->methods.xLock = lock_file;
	scheduled->methods.xUnlock = unlock_file;
	scheduled->methods.xCheckReservedLock = check_reserved;
	scheduled->methods.xFileControl = file_control;
	scheduled->methods.xSectorSize = sector_size;
	scheduled->methods.xDeviceCharacteristics = device_characteristics;
	if (scheduled->methods.iVersion >= 2) {
		scheduled->methods.xShmMap = shm_map;
		scheduled->methods.xShmLock = shm_lock;
		scheduled->methods.xShmBarrier = shm_barrier;
		scheduled->methods.xShmUnmap = shm_unmap;
	}
	if (scheduled->methods.iVersion >= 3) {
		scheduled->methods.xFetch = fetch;
		scheduled->methods.xUnfetch = unfetch;
	}
	scheduled->base.pMethods = &scheduled->methods;
	return SQLITE_OK;
}

int sqlite3_installlockschedule_init(sqlite3 *database, char **error,
	const sqlite3_api_routines *api) {
	(void)database;
	(void)error;
	SQLITE_EXTENSION_INIT2(api);
	role = getenv("GCP_TEST_LOCK_ROLE");
	if (!role || (strcmp(role, "A") != 0 && strcmp(role, "B") != 0)) return SQLITE_ERROR;
	original_vfs = sqlite3_vfs_find(NULL);
	scheduled_vfs = *original_vfs;
	scheduled_vfs.zName = "install-lock-schedule";
	scheduled_vfs.szOsFile = sizeof(ScheduledFile) + original_vfs->szOsFile;
	scheduled_vfs.xOpen = open_file;
	sqlite3_vfs_register(&scheduled_vfs, 1);
	/* The registered VFS must outlive the connection that loads the extension. */
	return SQLITE_OK_LOAD_PERMANENTLY;
}
