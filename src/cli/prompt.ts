import { createInterface } from "node:readline/promises";

/** Prompt the user for a line of input on the terminal. */
export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Prompt repeatedly until a non-empty value is provided. */
export async function promptRequired(
  question: string,
  errorMessage = "This value is required.",
): Promise<string> {
  for (;;) {
    const value = await prompt(question);
    if (value.length > 0) return value;
    process.stderr.write(`${errorMessage}\n`);
  }
}
