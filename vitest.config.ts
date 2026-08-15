import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Several build-runner tests drive real git inside a temporary repository.
     * On Windows a single `git` spawn regularly costs hundreds of milliseconds,
     * so those tests legitimately run for three to five seconds and sat within
     * noise of vitest's 5s default — one of them tipped over as soon as the
     * runner emitted one more event per attempt. The work is slow, not hung.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
