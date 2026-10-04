export class PatchworkError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PatchworkError";
    this.code = code;
  }
}

export function toPatchworkError(value: unknown): PatchworkError {
  if (value instanceof PatchworkError) return value;
  if (value instanceof Error) return new PatchworkError(value.message);
  return new PatchworkError("Unknown error");
}
