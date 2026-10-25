/**
 * How people are told to run the bench CLI, in every instruction the Director serves (the lobby's `join_command`)
 * and the CLI prints when it can't tell how it was started.
 *
 * The npm name `mtgdt-bench` is not claimed yet (docs/RELEASING.md, "The CLI package"). An `npx mtgdt-bench`
 * instruction would run whatever anyone publishes under that name, so until the package is published, instructions
 * use the git checkout that the setup prompt makes at ~/mtgdt-bench (prompts/setup.md step 1).
 *
 * After publishing, this is the one line to change: `npx -y mtgdt-bench@<version>` (always a pinned version).
 */
export const BENCH_COMMAND = 'npm --prefix ~/mtgdt-bench run -s bench --';
