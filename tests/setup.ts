/**
 * Vitest setup file — runs in each worker BEFORE any test file imports.
 *
 * Sets `BRAIN_DATA_DIR` to a per-worker temp dir so tests that touch
 * `writeDocument`/`readDocument` don't pollute the real `~/brain/`.
 *
 * Critical: `src/storage/brain-path.ts` evaluates `BRAIN_ROOT` at module
 * load time. If this env-set runs AFTER the brain-path import, the constant
 * is captured against the WRONG dir and tests collide with real data.
 * Wiring this via `setupFiles` ensures env is set first.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-test-'))
process.env.BRAIN_DATA_DIR = tmpBrainDir
