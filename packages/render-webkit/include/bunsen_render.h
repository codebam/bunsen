// SPDX-License-Identifier: MIT OR Apache-2.0
/*
 * Bunsen render backend ABI.
 *
 * This header IS the contract between the Bun shell and any rendering engine.
 * Phase 0 implements it over WebKitGTK; phase 2 implements it over Blitz
 * (Stylo/Taffy/Vello). The shell must never learn which one it is talking to.
 *
 * Two rules keep the boundary cheap and relocatable:
 *
 *   1. Everything crosses as an opaque byte buffer holding a *batch* of
 *      messages, never one FFI call per DOM operation.
 *   2. Nothing in the buffer is a pointer. The same bytes that travel over
 *      FFI today can travel over a socket to a sandboxed content process
 *      tomorrow without touching the shell.
 *
 * The buffer encoding is JSON while the protocol is still moving. Swapping it
 * for a binary format is a change to the codec on both sides, not to this ABI.
 *
 * Threading: bunsen_backend_start spawns the UI thread and returns. Every
 * other function is safe to call from any single thread (the Bun main thread).
 */

#ifndef BUNSEN_RENDER_H
#define BUNSEN_RENDER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BunsenBackend BunsenBackend;

/* Return codes. */
#define BUNSEN_OK          0
#define BUNSEN_ERR        -1  /* malformed input, or backend already stopped */
#define BUNSEN_ERR_NOSPACE -2  /* poll: out_cap too small, retry with a bigger buffer */

/*
 * Start the backend. `config_json` is a NUL-terminated UTF-8 JSON object:
 *   { "chrome_url": string, "width": u32, "height": u32, "chrome_height": u32 }
 * Returns NULL on failure.
 */
BunsenBackend *bunsen_backend_start(const char *config_json);

/*
 * Submit a batch of commands: a JSON array of objects, each `{ "op": ... }`.
 * The bytes are copied before returning; the caller may reuse the buffer.
 */
int32_t bunsen_backend_submit(BunsenBackend *b, const uint8_t *buf, size_t len);

/*
 * Drain pending events into `out`. Writes a JSON array of event objects.
 * Returns bytes written (0 when idle), or BUNSEN_ERR_NOSPACE.
 * Draining is all-or-nothing: on NOSPACE no events are consumed.
 */
int32_t bunsen_backend_poll(BunsenBackend *b, uint8_t *out, size_t out_cap);

/*
 * Register a wakeup callback, invoked from a dedicated backend thread each
 * time events become available, so the shell need not poll on a timer. The
 * callback must tolerate being called from a foreign thread and should do
 * nothing but schedule a bunsen_backend_poll on the shell's own thread.
 * May be set once per backend.
 */
int32_t bunsen_backend_set_wakeup(BunsenBackend *b, void (*callback)(void));

/* Stop the UI thread and free the handle. Safe to call once. */
void bunsen_backend_stop(BunsenBackend *b);

#ifdef __cplusplus
}
#endif

#endif /* BUNSEN_RENDER_H */
