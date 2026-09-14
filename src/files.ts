/** The two file-system facts the artifact cache and the link store share. */

import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Write a file so no reader ever sees half of it: to a partial beside it, then renamed over it.
 * The partial's name is unique, so two writes of one file in one process cannot collide.
 */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const partial = `${file}.${randomUUID()}.partial`
  await writeFile(partial, data)
  await rename(partial, file)
}

/** This server's directory under its XDG base: `~/.cache/coda-mcp`, or `~/.local/share/coda-mcp`. */
export function appDir(kind: 'cache' | 'data'): string {
  const base =
    kind === 'cache'
      ? process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'coda-mcp')
}
