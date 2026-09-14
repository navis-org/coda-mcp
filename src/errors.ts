/** An error's message, or the thrown value as text. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
