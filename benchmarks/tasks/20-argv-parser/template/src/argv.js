// Only understands `--name value`.
export function parseArgv(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      positionals.push(arg);
    }
  }

  return { _: positionals, flags };
}
