import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function createPromptSession() {
  return readline.createInterface({ input, output });
}

export async function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

export async function choose(rl, question, choices, defaultValue = choices[0].value) {
  console.log(question);
  choices.forEach((choice, index) => {
    const marker = choice.value === defaultValue ? " default" : "";
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });

  const answer = await rl.question("> ");
  const trimmed = answer.trim();

  if (!trimmed) {
    return defaultValue;
  }

  const number = Number.parseInt(trimmed, 10);
  if (Number.isInteger(number) && choices[number - 1]) {
    return choices[number - 1].value;
  }

  const match = choices.find((choice) => choice.value === trimmed);
  if (match) {
    return match.value;
  }

  throw new Error(`Invalid choice: ${trimmed}`);
}

export async function confirm(rl, question, defaultValue = false) {
  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = await rl.question(`${question} (${suffix}): `);
  const trimmed = answer.trim().toLowerCase();

  if (!trimmed) {
    return defaultValue;
  }

  return trimmed === "y" || trimmed === "yes";
}
