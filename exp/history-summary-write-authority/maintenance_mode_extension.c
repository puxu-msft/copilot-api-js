#include <sqlite3ext.h>
#include <stdint.h>
#include <stdlib.h>

SQLITE_EXTENSION_INIT1

typedef struct ConnectionState {
  uint64_t id;
  int enabled;
  struct ConnectionState *next;
} ConnectionState;

static ConnectionState *states = NULL;
static uint64_t next_id = 1;

static void maintenance_mode_sql(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  ConnectionState *state = sqlite3_user_data(context);
  sqlite3_result_int(context, state->enabled);
}

static void maintenance_connection_id_sql(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  ConnectionState *state = sqlite3_user_data(context);
  sqlite3_result_int64(context, (sqlite3_int64)state->id);
}

static void destroy_state(void *opaque) {
  ConnectionState *target = opaque;
  ConnectionState **cursor = &states;
  while (*cursor != NULL) {
    if (*cursor == target) {
      *cursor = target->next;
      free(target);
      return;
    }
    cursor = &(*cursor)->next;
  }
}

__attribute__((visibility("default")))
int maintenance_mode_set(uint64_t connection_id, int enabled) {
  ConnectionState *cursor = states;
  while (cursor != NULL) {
    if (cursor->id == connection_id) {
      cursor->enabled = enabled ? 1 : 0;
      return 0;
    }
    cursor = cursor->next;
  }
  return 1;
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_maintenancemode_init(sqlite3 *db, char **error_message, const sqlite3_api_routines *api) {
  (void)error_message;
  SQLITE_EXTENSION_INIT2(api);

  ConnectionState *state = calloc(1, sizeof(*state));
  if (state == NULL) return SQLITE_NOMEM;
  state->id = next_id++;
  state->next = states;
  states = state;

  int rc = sqlite3_create_function_v2(
    db,
    "maintenance_mode",
    0,
    SQLITE_UTF8,
    state,
    maintenance_mode_sql,
    NULL,
    NULL,
    NULL
  );
  if (rc != SQLITE_OK) {
    destroy_state(state);
    return rc;
  }

  rc = sqlite3_create_function_v2(
    db,
    "maintenance_connection_id",
    0,
    SQLITE_UTF8,
    state,
    maintenance_connection_id_sql,
    NULL,
    NULL,
    destroy_state
  );
  if (rc != SQLITE_OK) {
    sqlite3_create_function_v2(db, "maintenance_mode", 0, SQLITE_UTF8, NULL, NULL, NULL, NULL, NULL);
    destroy_state(state);
    return rc;
  }

  return SQLITE_OK;
}
