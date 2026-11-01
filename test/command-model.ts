// A hand-rolled command model over effect/Arbitrary lists: apply each generated command to the real
// code and to a small reference model, and compare them after every step. A step returns the first
// mismatch as text; the run stops there and keeps it, so a failing property can say what diverged.
export type Step<C> = (command: C, index: number) => Promise<string | undefined> | string | undefined;

export const replay = async <C>(commands: readonly C[], step: Step<C>, onMismatch?: (why: string) => void): Promise<boolean> => {
  for (const [index, command] of commands.entries()) {
    // Commands are a sequence: each one observes the state the previous one left behind.
    // oxlint-disable-next-line no-await-in-loop
    const why = await step(command, index);
    if (why !== undefined) {
      onMismatch?.(`step ${index} ${JSON.stringify(command)}: ${why}`);
      return false;
    }
  }
  return true;
};

export const same = (label: string, actual: unknown, expected: unknown): string | undefined => {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  return a === e ? undefined : `${label}: got ${a}, model ${e}`;
};

export const firstOf = (...checks: readonly (string | undefined)[]): string | undefined => checks.find((check) => check !== undefined);
