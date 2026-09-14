export function parseArgs(args) {
  const parsed = {
    flags: new Set(),
    values: {}
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);

    if (inlineValue !== undefined) {
      parsed.values[rawName] = inlineValue;
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      parsed.values[rawName] = next;
      index += 1;
    } else {
      parsed.flags.add(rawName);
    }
  }

  return parsed;
}
