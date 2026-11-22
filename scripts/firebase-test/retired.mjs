console.error(
  "The real Firebase guest-auth harness is retired. Use isolated host-model tests; do not activate SMS.",
);
process.exitCode = 1;
